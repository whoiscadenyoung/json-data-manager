import {
  APP_LIMITS,
  widgetDatasetIds,
  type Widget,
  type WidgetKind,
} from "#convex/appBuilder/validators";

/**
 * The app canvas's layout model — pure, React-free. An app is an ORDERED
 * list of widgets flowing through a 12-column CSS grid (`grid-auto-flow:
 * dense`), each with a column span `w` and a height `h` in row units. Order
 * is the only position: reordering is moving an item in the list, resizing
 * is changing its span. That keeps layouts responsive by construction (on
 * narrow screens every widget simply stacks full-width) and the stored
 * shape trivial, at the cost of free-form x/y placement — a deliberate
 * trade for a "simple and clean" builder.
 */

export const GRID_COLUMNS = APP_LIMITS.columns;
export const MAX_HEIGHT = APP_LIMITS.maxHeight;
/** One grid row unit, in px (the viewer and the builder share it). */
export const ROW_HEIGHT = 64;
/** Grid gap, in px — the resize math needs it. */
export const GRID_GAP = 16;

/** Each kind's footprint when first added. */
export const DEFAULT_SIZES: Record<WidgetKind, { w: number; h: number }> = {
  chart: { h: 5, w: 6 },
  map: { h: 7, w: 8 },
  stat: { h: 2, w: 3 },
  table: { h: 6, w: 12 },
  text: { h: 2, w: 12 },
};

/** Named widths for the inspector's size picker. */
export const WIDTH_PRESETS = [
  { label: "¼", w: 3 },
  { label: "⅓", w: 4 },
  { label: "½", w: 6 },
  { label: "⅔", w: 8 },
  { label: "¾", w: 9 },
  { label: "Full", w: 12 },
] as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A fresh, collision-safe widget id (client-minted; the server only checks uniqueness). */
export function newWidgetId(): string {
  return `w-${crypto.randomUUID().slice(0, 8)}`;
}

/** Moves the widget at `from` to index `to` (both clamped), returning a new list. */
export function moveWidget(widgets: readonly Widget[], from: number, to: number): Widget[] {
  const next = [...widgets];
  if (from < 0 || from >= next.length) {
    return next;
  }
  const [moved] = next.splice(from, 1);
  next.splice(clamp(to, 0, next.length), 0, moved);
  return next;
}

/** Patches one widget by id, keeping every other widget's reference. */
export function updateWidget(
  widgets: readonly Widget[],
  id: string,
  update: (widget: Widget) => Widget,
): Widget[] {
  return widgets.map((widget) => (widget.id === id ? update(widget) : widget));
}

/** Sets one widget's footprint, clamped to the grid. */
export function resizeWidget(
  widgets: readonly Widget[],
  id: string,
  size: { w?: number; h?: number },
): Widget[] {
  return updateWidget(widgets, id, (widget) => ({
    ...widget,
    h: clamp(size.h ?? widget.h, 1, MAX_HEIGHT),
    w: clamp(size.w ?? widget.w, 1, GRID_COLUMNS),
  }));
}

/**
 * The span a pointer drag lands on: the starting span plus the pointer's
 * travel converted to grid tracks (column width + gap per step), clamped.
 */
export function spanFromDrag(
  startSpan: number,
  deltaPx: number,
  trackPx: number,
  max: number,
): number {
  if (trackPx <= 0) {
    return startSpan;
  }
  return clamp(startSpan + deltaPx / trackPx, 1, max);
}

/**
 * Drops a dataset from an app's widgets: dataset-bound widgets on it are
 * removed, maps just lose the layer. What removing a data source does.
 */
export function withoutDataset(widgets: readonly Widget[], datasetId: string): Widget[] {
  return widgets.flatMap((widget): Widget[] => {
    if (widget.kind === "map") {
      return [{ ...widget, datasetIds: widget.datasetIds.filter((id) => id !== datasetId) }];
    }
    return widgetDatasetIds(widget).includes(datasetId) ? [] : [widget];
  });
}

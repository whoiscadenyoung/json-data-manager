import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, GripVertical, MoveDiagonal2, Trash2 } from "lucide-react";
import {
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import type { Widget } from "#convex/appBuilder/validators";

import {
  GRID_COLUMNS,
  GRID_GAP,
  MAX_HEIGHT,
  moveWidget,
  ROW_HEIGHT,
  spanFromDrag,
} from "../lib/layout";
import { widgetKindInfo, WidgetView } from "../widgets/registry";

/**
 * The app canvas: widgets flowing through a 12-column grid in list order
 * (see lib/layout.ts). The SAME component renders the shared viewer and the
 * builder — `editing` only adds chrome (selection, drag handle, resize
 * handle, quick actions) — so what an author lays out is exactly what
 * viewers get. Below the `md` breakpoint every widget stacks full-width.
 */

/** Title bar height, px — subtracted from a widget's footprint to size its body. */
const TITLE_BAR = 40;

function frameHeight(h: number): number {
  return h * ROW_HEIGHT + (h - 1) * GRID_GAP;
}

function gridStyle(widget: Widget): CSSProperties {
  return {
    // Read by the md: grid-column utility below; mobile ignores it.
    ["--w" as string]: widget.w,
    gridRow: `span ${widget.h} / span ${widget.h}`,
  };
}

/** The grid's column and row tracks in px (cell + gap), for pointer-drag resizing. */
function trackSizes(grid: HTMLElement | null): { column: number; row: number } {
  const width = grid === null ? 0 : grid.clientWidth;
  return {
    column: (width - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GRID_GAP,
    row: ROW_HEIGHT + GRID_GAP,
  };
}

function WidgetHeader({ widget, editing }: { widget: Widget; editing: boolean }) {
  const info = widgetKindInfo(widget.kind),
    Icon = info.icon;
  if (widget.title === undefined || widget.title === "") {
    return editing ? (
      <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {info.label}
      </div>
    ) : null;
  }
  return (
    <div className="flex h-10 shrink-0 items-center px-4">
      <h2 className="truncate text-sm font-semibold">{widget.title}</h2>
    </div>
  );
}

function hasHeader(widget: Widget, editing: boolean): boolean {
  return editing || (widget.title !== undefined && widget.title !== "");
}

/** Read-only widget card (the viewer). */
function ViewWidget({ widget }: { widget: Widget }) {
  const body = frameHeight(widget.h) - (hasHeader(widget, false) ? TITLE_BAR : 0);
  return (
    <section
      style={gridStyle(widget)}
      className="col-span-1 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card md:[grid-column:span_var(--w)/span_var(--w)]"
    >
      <WidgetHeader widget={widget} editing={false} />
      <div className="min-h-0 flex-1">
        <WidgetView widget={widget} height={body} />
      </div>
    </section>
  );
}

interface EditActions {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}

/** Pointer-drag on the corner handle: live-resizes in whole grid tracks. */
function useResizeDrag(
  widget: Widget,
  gridRef: RefObject<HTMLDivElement | null>,
  onResize: EditActions["onResize"],
) {
  return (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const start = { h: widget.h, w: widget.w, x: event.clientX, y: event.clientY },
      tracks = trackSizes(gridRef.current),
      target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let last = { h: widget.h, w: widget.w };
    const move = (moveEvent: PointerEvent) => {
      const next = {
        h: spanFromDrag(start.h, moveEvent.clientY - start.y, tracks.row, MAX_HEIGHT),
        w: spanFromDrag(start.w, moveEvent.clientX - start.x, tracks.column, GRID_COLUMNS),
      };
      if (next.w !== last.w || next.h !== last.h) {
        last = next;
        onResize(widget.id, next);
      }
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
}

function EditWidget({
  widget,
  gridRef,
  actions,
}: {
  widget: Widget;
  gridRef: RefObject<HTMLDivElement | null>;
  actions: EditActions;
}) {
  const {
      attributes,
      listeners,
      setNodeRef,
      setActivatorNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: widget.id }),
    selected = actions.selectedId === widget.id,
    startResize = useResizeDrag(widget, gridRef, actions.onResize),
    body = frameHeight(widget.h) - TITLE_BAR;
  return (
    <section
      ref={setNodeRef}
      style={{ ...gridStyle(widget), transform: CSS.Translate.toString(transform), transition }}
      aria-label={`${widgetKindInfo(widget.kind).label} widget${widget.title === undefined ? "" : `: ${widget.title}`}`}
      onPointerDownCapture={() => {
        actions.onSelect(widget.id);
      }}
      onFocusCapture={() => {
        actions.onSelect(widget.id);
      }}
      className={cn(
        "group/widget relative col-span-1 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card transition-shadow md:[grid-column:span_var(--w)/span_var(--w)]",
        selected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border hover:border-primary/50",
        isDragging && "z-20 opacity-80 shadow-xl",
      )}
    >
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="flex h-10 cursor-grab items-center pl-2 text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>
        <div className="min-w-0 flex-1 [&>div]:pl-1">
          <WidgetHeader widget={widget} editing />
        </div>
        <div
          className={cn(
            "flex items-center gap-0.5 pr-2 transition-opacity",
            selected
              ? "opacity-100"
              : "opacity-0 group-hover/widget:opacity-100 focus-within:opacity-100",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Duplicate widget"
            title="Duplicate"
            onClick={() => {
              actions.onDuplicate(widget.id);
            }}
          >
            <Copy />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove widget"
            title="Remove"
            onClick={() => {
              actions.onRemove(widget.id);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <WidgetView widget={widget} height={body} />
      </div>
      <button
        type="button"
        aria-label="Drag to resize"
        title="Drag to resize"
        onPointerDown={startResize}
        className={cn(
          "absolute right-0.5 bottom-0.5 z-20 flex size-6 cursor-nwse-resize items-center justify-center rounded-md bg-card/90 text-muted-foreground shadow-sm transition-opacity hover:text-primary",
          selected ? "opacity-100" : "opacity-0 group-hover/widget:opacity-100",
        )}
      >
        <MoveDiagonal2 className="size-3.5" />
      </button>
    </section>
  );
}

const GRID_CLASS = "grid grid-flow-row-dense grid-cols-1 gap-4 md:grid-cols-12";
const GRID_STYLE: CSSProperties = { gridAutoRows: `${ROW_HEIGHT}px` };

export function AppCanvasView({ widgets }: { widgets: readonly Widget[] }) {
  return (
    <div className={GRID_CLASS} style={GRID_STYLE}>
      {widgets.map((widget) => (
        <ViewWidget key={widget.id} widget={widget} />
      ))}
    </div>
  );
}

export function AppCanvasEditor({
  widgets,
  onReorder,
  ...actions
}: EditActions & {
  widgets: readonly Widget[];
  onReorder: (next: Widget[]) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null),
    sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
      useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    ),
    handleDragEnd = (event: DragEndEvent) => {
      const { active, over } = event;
      if (over === null || active.id === over.id) {
        return;
      }
      const from = widgets.findIndex((widget) => widget.id === active.id),
        to = widgets.findIndex((widget) => widget.id === over.id);
      onReorder(moveWidget(widgets, from, to));
    };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={widgets.map((widget) => widget.id)} strategy={rectSortingStrategy}>
        <div ref={gridRef} className={GRID_CLASS} style={GRID_STYLE}>
          {widgets.map((widget) => (
            <EditWidget key={widget.id} widget={widget} gridRef={gridRef} actions={actions} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

import { Button } from "@caden/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@caden/ui/components/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@caden/ui/components/tooltip";
import { cn } from "@caden/ui/lib/utils";
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
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import type { PageLayout, Widget } from "#convex/appBuilder/validators";

import {
  GRID_COLUMNS,
  GRID_GAP,
  MAX_HEIGHT,
  moveItem,
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
 *
 * Two page layouts share the grid (see `PageLayout`): `contained` rows are a
 * fixed `ROW_HEIGHT`, so a page scrolls like a document; `fullscreen` rows
 * stretch (`1fr`, never below `MIN_STRETCH_ROW`) so the page's widgets fill
 * the height the canvas is given — a 12-row map fills the screen. Widget
 * bodies measure their own height, so both layouts size widgets the same way.
 */

/** The smallest a stretched (full-screen) row may get before the page scrolls instead. */
const MIN_STRETCH_ROW = 40;

/** The rendered height of an element, live (ResizeObserver). */
function useElementHeight<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null),
    [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(0);
      if (entry !== undefined) {
        setHeight(Math.round(entry.contentRect.height));
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, height];
}

/** A widget's body, sized by whatever space its card gives it. */
function WidgetBody({ widget }: { widget: Widget }) {
  const [ref, height] = useElementHeight<HTMLDivElement>();
  return (
    <CardContent ref={ref} className="min-h-0 flex-1 px-0">
      <WidgetView widget={widget} height={height} />
    </CardContent>
  );
}

function gridStyle(widget: Widget): CSSProperties {
  return {
    // Read by the md: grid-column utility below; mobile ignores it.
    ["--w" as string]: widget.w,
    gridRow: `span ${widget.h} / span ${widget.h}`,
  };
}

/** The first row track's rendered height — fixed on contained pages, stretched on full-screen ones. */
function rowHeight(grid: HTMLElement): number {
  const first = Number.parseFloat(getComputedStyle(grid).gridTemplateRows.split(" ")[0]);
  return Number.isFinite(first) && first > 0 ? first : ROW_HEIGHT;
}

/** The grid's column and row tracks in px (cell + gap), for pointer-drag resizing. */
function trackSizes(grid: HTMLElement | null): { column: number; row: number } {
  if (grid === null) {
    return { column: 0, row: ROW_HEIGHT + GRID_GAP };
  }
  return {
    column: (grid.clientWidth - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GRID_GAP,
    row: rowHeight(grid) + GRID_GAP,
  };
}

/** A tooltip-labelled icon button (the canvas's quick actions and handles). */
function IconAction({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className={className}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function hasTitle(widget: Widget): boolean {
  return widget.title !== undefined && widget.title !== "";
}

/** Read-only widget card (the viewer). */
function ViewWidget({ widget }: { widget: Widget }) {
  return (
    <section
      aria-label={hasTitle(widget) ? widget.title : widgetKindInfo(widget.kind).label}
      style={gridStyle(widget)}
      className={GRID_ITEM_CLASS}
    >
      <Card className="size-full gap-0 py-0">
        {hasTitle(widget) && (
          <CardHeader className="flex h-10 shrink-0 items-center">
            <CardTitle className="truncate font-semibold">
              <h2>{widget.title}</h2>
            </CardTitle>
          </CardHeader>
        )}
        <WidgetBody widget={widget} />
      </Card>
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
    startResize = useResizeDrag(widget, gridRef, actions.onResize);
  const info = widgetKindInfo(widget.kind),
    Icon = info.icon;
  return (
    <section
      ref={setNodeRef}
      style={{ ...gridStyle(widget), transform: CSS.Translate.toString(transform), transition }}
      aria-label={`${info.label} widget${hasTitle(widget) ? `: ${widget.title}` : ""}`}
      onPointerDownCapture={() => {
        actions.onSelect(widget.id);
      }}
      onFocusCapture={() => {
        actions.onSelect(widget.id);
      }}
      className={cn("group/widget relative", GRID_ITEM_CLASS, isDragging && "z-20 opacity-80")}
    >
      <Card
        className={cn(
          "size-full gap-0 py-0",
          selected ? "ring-2 ring-primary" : "group-hover/widget:ring-primary/40",
          isDragging && "shadow-xl",
        )}
      >
        <CardHeader className="flex h-10 shrink-0 items-center gap-1 px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            className="cursor-grab text-muted-foreground active:cursor-grabbing"
          >
            <GripVertical />
          </Button>
          <CardTitle className="min-w-0 flex-1 truncate">
            {hasTitle(widget) ? (
              <h2 className="truncate font-semibold">{widget.title}</h2>
            ) : (
              <span className="flex items-center gap-2 font-normal text-muted-foreground">
                <Icon className="size-3.5" />
                {info.label}
              </span>
            )}
          </CardTitle>
          <CardAction
            className={cn(
              "flex items-center gap-0.5 self-center transition-opacity",
              selected
                ? "opacity-100"
                : "opacity-0 group-hover/widget:opacity-100 focus-within:opacity-100",
            )}
          >
            <IconAction
              label="Duplicate widget"
              onClick={() => {
                actions.onDuplicate(widget.id);
              }}
            >
              <Copy />
            </IconAction>
            <IconAction
              label="Remove widget"
              onClick={() => {
                actions.onRemove(widget.id);
              }}
            >
              <Trash2 />
            </IconAction>
          </CardAction>
        </CardHeader>
        <WidgetBody widget={widget} />
        <IconAction
          label="Drag to resize"
          onPointerDown={startResize}
          className={cn(
            "absolute right-0.5 bottom-0.5 z-20 cursor-nwse-resize bg-card text-muted-foreground shadow-sm transition-opacity",
            selected ? "opacity-100" : "opacity-0 group-hover/widget:opacity-100",
          )}
        >
          <MoveDiagonal2 />
        </IconAction>
      </Card>
    </section>
  );
}

/** One grid cell: full-width on phones, its own column span from `md` up. */
const GRID_ITEM_CLASS =
  "col-span-1 flex min-h-0 min-w-0 md:[grid-column:span_var(--w)/span_var(--w)]";

const GRID_CLASS = "grid grid-flow-row-dense grid-cols-1 gap-4 md:grid-cols-12";

/**
 * The grid for a page layout. Phones always use fixed rows (a stretched
 * single column would squash every widget); from `md` up a full-screen page
 * fills its container's height and stretches its rows.
 */
function gridProps(layout: PageLayout): { className: string; style: CSSProperties } {
  if (layout === "fullscreen") {
    return {
      className: cn(GRID_CLASS, "md:h-full md:[grid-auto-rows:minmax(var(--min-row),1fr)]"),
      style: {
        ["--min-row" as string]: `${MIN_STRETCH_ROW}px`,
        gridAutoRows: `${ROW_HEIGHT}px`,
      },
    };
  }
  return { className: GRID_CLASS, style: { gridAutoRows: `${ROW_HEIGHT}px` } };
}

export function AppCanvasView({
  widgets,
  layout,
}: {
  widgets: readonly Widget[];
  layout: PageLayout;
}) {
  return (
    <div {...gridProps(layout)}>
      {widgets.map((widget) => (
        <ViewWidget key={widget.id} widget={widget} />
      ))}
    </div>
  );
}

export function AppCanvasEditor({
  widgets,
  layout,
  onReorder,
  ...actions
}: EditActions & {
  widgets: readonly Widget[];
  layout: PageLayout;
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
      onReorder(moveItem(widgets, from, to));
    };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={widgets.map((widget) => widget.id)} strategy={rectSortingStrategy}>
        <div ref={gridRef} {...gridProps(layout)}>
          {widgets.map((widget) => (
            <EditWidget key={widget.id} widget={widget} gridRef={gridRef} actions={actions} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

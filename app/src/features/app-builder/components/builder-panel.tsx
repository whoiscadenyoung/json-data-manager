import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Database,
  EyeOff,
  Info,
  Maximize2,
  Minus,
  MousePointerClick,
  PanelTop,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";

import { DatasetPickerSheet } from "#/components/dataset-picker-sheet";
import { Alert, AlertDescription } from "#/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "#/components/ui/button-group";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "#/components/ui/item";
import { Separator } from "#/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { api } from "#convex/_generated/api";
import {
  APP_LIMITS,
  widgetDatasetIds,
  type AppContent,
  type AppPage,
  type PageLayout,
  type Widget,
  type WidgetKind,
} from "#convex/appBuilder/validators";

import { datasetTitle, useAppDatasets, type DatasetState } from "../data";
import { MAX_HEIGHT, WIDTH_PRESETS } from "../lib/layout";
import { allWidgets, pagesWithoutDataset, removePage, shiftPage, updatePage } from "../lib/pages";
import { createWidget, WIDGET_KINDS, widgetKindInfo, WidgetSettings } from "../widgets/registry";

/**
 * The builder's side panel: Add (widget palette), Data (the app's sources),
 * and Widget (the selected widget's inspector) — composed from the shadcn
 * base-ui kit (Item, Field, ToggleGroup, ButtonGroup, Empty, AlertDialog).
 * Every disabled control says why (the "no silent disabled buttons" rule,
 * docs/memory).
 */

export type PanelTab = "add" | "data" | "widget" | "page";

function AddPanel({
  hasData,
  full,
  onAdd,
}: {
  hasData: boolean;
  full: boolean;
  onAdd: (kind: WidgetKind) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {full && (
        <Alert>
          <Info />
          <AlertDescription>
            This page (or the app) has the most widgets it can hold — remove one, or add it to
            another page.
          </AlertDescription>
        </Alert>
      )}
      <ItemGroup className="grid grid-cols-2 gap-2">
        {WIDGET_KINDS.map((info) => {
          const Icon = info.icon,
            disabled = full || (info.needsData && !hasData);
          return (
            <Item
              key={info.kind}
              variant="outline"
              className="items-start hover:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-50"
              render={
                <button
                  type="button"
                  aria-label={`Add ${info.label}: ${info.description}`}
                  disabled={disabled}
                  aria-disabled={disabled}
                  onClick={() => {
                    onAdd(info.kind);
                  }}
                />
              }
            >
              <ItemMedia variant="icon">
                <Icon />
              </ItemMedia>
              <ItemContent className="text-left">
                <ItemTitle>{info.label}</ItemTitle>
                <ItemDescription>{info.description}</ItemDescription>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
      {!hasData && (
        <Alert>
          <Info />
          <AlertDescription>
            Maps, charts, tables and numbers read from the app's datasets — add one on the Data tab
            first.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function kindLabel(state: DatasetState): string | undefined {
  if (state.status !== "ready") {
    return undefined;
  }
  return state.doc.kind === "geospatial" ? (state.doc.geometryType ?? "Geospatial") : "Table";
}

function sizeLabel(state: DatasetState): string | undefined {
  if (state.status !== "ready") {
    return undefined;
  }
  const count = state.doc.kind === "geospatial" ? state.doc.featureCount : state.doc.entryCount;
  if (count === undefined) {
    return undefined;
  }
  return `${count.toLocaleString()} ${state.doc.kind === "geospatial" ? "features" : "rows"}`;
}

/** Confirms removing a dataset that widgets still use (they go with it). */
function RemoveDatasetDialog({
  title,
  usedBy,
  open,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  usedBy: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {title} from the app?</AlertDialogTitle>
          <AlertDialogDescription>
            {usedBy} {usedBy === 1 ? "widget uses" : "widgets use"} this dataset and will be removed
            with it (maps just lose the layer). The dataset itself isn't affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DatasetRow({
  datasetId,
  state,
  usedBy,
  onRemove,
}: {
  datasetId: string;
  state: DatasetState;
  usedBy: number;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false),
    restricted = state.status === "ready" && state.doc.publishedVisibility === "author",
    kind = kindLabel(state),
    size = sizeLabel(state),
    title = datasetTitle(state);
  return (
    <Item variant="outline">
      <ItemContent>
        {(kind !== undefined || restricted) && (
          <div className="flex flex-wrap items-center gap-1">
            {kind !== undefined && <Badge variant="secondary">{kind}</Badge>}
            {restricted && (
              <Badge variant="outline">
                <EyeOff data-icon="inline-start" />
                Only you
              </Badge>
            )}
          </div>
        )}
        <ItemTitle>
          {state.status === "ready" ? (
            <Link
              to="/datasets/$schemaId"
              params={{ schemaId: datasetId }}
              className="hover:underline"
            >
              {title}
            </Link>
          ) : (
            title
          )}
        </ItemTitle>
        {size !== undefined && <ItemDescription>{size}</ItemDescription>}
        {restricted && (
          <ItemDescription>
            People you share this app with won't see this dataset's widgets.
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${title} from the app`}
          title="Remove from app"
          onClick={() => {
            if (usedBy === 0) {
              onRemove();
            } else {
              setConfirming(true);
            }
          }}
        >
          <Trash2 />
        </Button>
      </ItemActions>
      <RemoveDatasetDialog
        title={title}
        usedBy={usedBy}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={onRemove}
      />
    </Item>
  );
}

function DataPanel({
  content,
  onAddDataset,
  onRemoveDataset,
}: {
  content: AppContent;
  onAddDataset: (datasetId: string) => void;
  onRemoveDataset: (datasetId: string) => void;
}) {
  const states = useAppDatasets(),
    [pickerOpen, setPickerOpen] = useState(false),
    summaries = useQuery({ ...convexQuery(api.schemas.listSummaries, { limit: 500 }) }).data,
    inApp = new Set(content.datasetIds),
    candidates = (summaries ?? []).filter((summary) => !inApp.has(summary._id)),
    full = content.datasetIds.length >= APP_LIMITS.datasets;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Datasets this app reads from. Widgets pick from this list; viewers see each dataset only if
        they could open it themselves.
      </p>
      {content.datasetIds.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database />
            </EmptyMedia>
            <EmptyTitle>No datasets yet</EmptyTitle>
            <EmptyDescription>Add one from the catalog to start building.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {content.datasetIds.map((datasetId) => (
            <DatasetRow
              key={datasetId}
              datasetId={datasetId}
              state={states.get(datasetId) ?? { status: "loading" }}
              usedBy={
                allWidgets(content.pages).filter((widget) =>
                  widgetDatasetIds(widget).includes(datasetId),
                ).length
              }
              onRemove={() => {
                onRemoveDataset(datasetId);
              }}
            />
          ))}
        </ItemGroup>
      )}
      <Button
        type="button"
        disabled={full || summaries === undefined}
        onClick={() => {
          setPickerOpen(true);
        }}
      >
        <Plus data-icon="inline-start" />
        {summaries === undefined ? "Loading catalog…" : "Add dataset"}
      </Button>
      {full && (
        <p className="text-xs text-muted-foreground">
          An app holds up to {APP_LIMITS.datasets} datasets.
        </p>
      )}
      <Button variant="link" size="sm" render={<Link to="/datasets/create" />}>
        <Upload data-icon="inline-start" />
        Import new data into the catalog
      </Button>
      <DatasetPickerSheet
        title="Add a dataset"
        description="Pick a catalog dataset for this app's widgets to use."
        candidates={candidates}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (dataset) => {
          onAddDataset(dataset._id);
        }}
      />
    </div>
  );
}

function SizeControls({ widget, onChange }: { widget: Widget; onChange: (next: Widget) => void }) {
  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label">Width</FieldLegend>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          className="w-full"
          value={[String(widget.w)]}
          onValueChange={(values) => {
            const w = Number(values.at(0));
            if (Number.isInteger(w)) {
              onChange({ ...widget, w });
            }
          }}
        >
          {WIDTH_PRESETS.map((preset) => (
            <ToggleGroupItem
              key={preset.w}
              value={String(preset.w)}
              aria-label={`Width ${preset.label}`}
              className="flex-1"
            >
              {preset.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
      <Field orientation="horizontal" className="justify-between">
        <FieldLabel>Height</FieldLabel>
        <ButtonGroup>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Shorter"
            disabled={widget.h <= 1}
            onClick={() => {
              onChange({ ...widget, h: widget.h - 1 });
            }}
          >
            <Minus />
          </Button>
          <ButtonGroupText className="h-6 w-16 justify-center tabular-nums">
            {widget.h} rows
          </ButtonGroupText>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Taller"
            disabled={widget.h >= MAX_HEIGHT}
            onClick={() => {
              onChange({ ...widget, h: widget.h + 1 });
            }}
          >
            <Plus />
          </Button>
        </ButtonGroup>
      </Field>
      <FieldDescription>
        Or drag a widget's corner on the canvas. Drag its handle to reorder.
      </FieldDescription>
    </FieldGroup>
  );
}

function WidgetPanel({
  widget,
  datasetIds,
  onChange,
}: {
  widget: Widget | undefined;
  datasetIds: readonly string[];
  onChange: (next: Widget) => void;
}) {
  if (widget === undefined) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MousePointerClick />
          </EmptyMedia>
          <EmptyTitle>No widget selected</EmptyTitle>
          <EmptyDescription>Select a widget on the canvas to edit it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const info = widgetKindInfo(widget.kind),
    Icon = info.icon;
  return (
    <FieldGroup>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="text-primary" />
        {info.label}
      </div>
      <Field>
        <FieldLabel htmlFor={`widget-title-${widget.id}`}>Title</FieldLabel>
        <Input
          id={`widget-title-${widget.id}`}
          value={widget.title ?? ""}
          maxLength={APP_LIMITS.title}
          placeholder="Optional"
          onChange={(event) => {
            const title = event.target.value;
            onChange({ ...widget, title: title === "" ? undefined : title });
          }}
        />
      </Field>
      <WidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />
      <Separator />
      <SizeControls widget={widget} onChange={onChange} />
    </FieldGroup>
  );
}

const LAYOUTS: ReadonlyArray<{
  value: PageLayout;
  label: string;
  description: string;
  icon: typeof PanelTop;
}> = [
  {
    description: "A centered column with fixed-height rows — scrolls like a report.",
    icon: PanelTop,
    label: "Contained",
    value: "contained",
  },
  {
    description: "Edge to edge; rows stretch to fill the screen — a 12-row map fills it.",
    icon: Maximize2,
    label: "Full screen",
    value: "fullscreen",
  },
];

/** The active page's settings: title, layout mode, order, and delete. */
function PagePanel({
  page,
  pages,
  onChange,
  onShift,
  onRemove,
}: {
  page: AppPage;
  pages: readonly AppPage[];
  onChange: (next: AppPage) => void;
  onShift: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false),
    index = pages.findIndex((candidate) => candidate.id === page.id),
    layout = LAYOUTS.find((option) => option.value === page.layout) ?? LAYOUTS[0],
    untitled = page.title.trim() === "";
  return (
    <FieldGroup>
      <Field data-invalid={untitled ? true : undefined}>
        <FieldLabel htmlFor={`page-title-${page.id}`}>Page title</FieldLabel>
        <Input
          id={`page-title-${page.id}`}
          value={page.title}
          maxLength={APP_LIMITS.pageTitle}
          aria-invalid={untitled ? true : undefined}
          onChange={(event) => {
            onChange({ ...page, title: event.target.value });
          }}
        />
        {untitled && (
          <FieldDescription>A page needs a title before the app can save.</FieldDescription>
        )}
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Layout</FieldLegend>
        <ToggleGroup
          variant="outline"
          spacing={0}
          className="w-full"
          value={[page.layout]}
          onValueChange={(values) => {
            const next = LAYOUTS.find((option) => option.value === values.at(0));
            if (next !== undefined) {
              onChange({ ...page, layout: next.value });
            }
          }}
        >
          {LAYOUTS.map((option) => {
            const Icon = option.icon;
            return (
              <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
                <Icon data-icon="inline-start" />
                {option.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <FieldDescription>{layout.description}</FieldDescription>
      </FieldSet>
      <Field orientation="horizontal" className="justify-between">
        <FieldLabel>Order</FieldLabel>
        <ButtonGroup>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index <= 0}
            onClick={() => {
              onShift(-1);
            }}
          >
            <ArrowLeft data-icon="inline-start" />
            Earlier
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index >= pages.length - 1}
            onClick={() => {
              onShift(1);
            }}
          >
            Later
            <ArrowRight data-icon="inline-end" />
          </Button>
        </ButtonGroup>
      </Field>
      <Separator />
      <Button
        type="button"
        variant="destructive"
        disabled={pages.length <= 1}
        onClick={() => {
          if (page.widgets.length === 0) {
            onRemove();
          } else {
            setConfirming(true);
          }
        }}
      >
        <Trash2 data-icon="inline-start" />
        Delete page
      </Button>
      {pages.length <= 1 && <FieldDescription>An app needs at least one page.</FieldDescription>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{page.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {page.widgets.length} {page.widgets.length === 1 ? "widget" : "widgets"} will be
              deleted with it. The app's datasets aren't affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
            >
              Delete page
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldGroup>
  );
}

const PANEL_TABS: readonly PanelTab[] = ["add", "data", "widget", "page"];

export function BuilderPanel({
  tab,
  onTabChange,
  content,
  page,
  selected,
  onUpdate,
  onSelect,
  onSelectPage,
}: {
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  content: AppContent;
  /** The page the canvas is showing — widgets are added to and edited on it. */
  page: AppPage;
  selected: Widget | undefined;
  onUpdate: (change: (prev: AppContent) => AppContent) => void;
  onSelect: (id: string | undefined) => void;
  onSelectPage: (pageId: string) => void;
}) {
  const states = useAppDatasets(),
    updateThisPage = (change: (current: AppPage) => AppPage) => {
      onUpdate((prev) => ({ ...prev, pages: updatePage(prev.pages, page.id, change) }));
    },
    full =
      page.widgets.length >= APP_LIMITS.widgets ||
      allWidgets(content.pages).length >= APP_LIMITS.totalWidgets;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        const next = PANEL_TABS.find((candidate) => candidate === value);
        if (next !== undefined) {
          onTabChange(next);
        }
      }}
      className="flex h-full flex-col"
    >
      <TabsList className="w-full">
        <TabsTrigger value="add">Add</TabsTrigger>
        <TabsTrigger value="data">Data ({content.datasetIds.length})</TabsTrigger>
        <TabsTrigger value="widget">Widget</TabsTrigger>
        <TabsTrigger value="page">Page</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto pt-4">
        <TabsContent value="add">
          <AddPanel
            hasData={content.datasetIds.length > 0}
            full={full}
            onAdd={(kind) => {
              const widget = createWidget(kind, content.datasetIds, states);
              updateThisPage((current) => ({ ...current, widgets: [...current.widgets, widget] }));
              onSelect(widget.id);
              onTabChange("widget");
            }}
          />
        </TabsContent>
        <TabsContent value="data">
          <DataPanel
            content={content}
            onAddDataset={(datasetId) => {
              onUpdate((prev) => ({ ...prev, datasetIds: [...prev.datasetIds, datasetId] }));
            }}
            onRemoveDataset={(datasetId) => {
              onUpdate((prev) => ({
                datasetIds: prev.datasetIds.filter((id) => id !== datasetId),
                pages: pagesWithoutDataset(prev.pages, datasetId),
              }));
            }}
          />
        </TabsContent>
        <TabsContent value="widget">
          <WidgetPanel
            widget={selected}
            datasetIds={content.datasetIds}
            onChange={(next) => {
              updateThisPage((current) => ({
                ...current,
                widgets: current.widgets.map((widget) => (widget.id === next.id ? next : widget)),
              }));
            }}
          />
        </TabsContent>
        <TabsContent value="page">
          <PagePanel
            key={page.id}
            page={page}
            pages={content.pages}
            onChange={(next) => {
              updateThisPage(() => next);
            }}
            onShift={(delta) => {
              onUpdate((prev) => ({ ...prev, pages: shiftPage(prev.pages, page.id, delta) }));
            }}
            onRemove={() => {
              const remaining = removePage(content.pages, page.id);
              onUpdate((prev) => ({ ...prev, pages: removePage(prev.pages, page.id) }));
              onSelectPage(remaining[0].id);
            }}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}

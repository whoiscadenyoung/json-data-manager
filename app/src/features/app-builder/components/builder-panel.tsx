import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Database,
  EyeOff,
  Info,
  Minus,
  MousePointerClick,
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
  type Widget,
  type WidgetKind,
} from "#convex/appBuilder/validators";

import { datasetTitle, useAppDatasets, type DatasetState } from "../data";
import { MAX_HEIGHT, WIDTH_PRESETS, withoutDataset } from "../lib/layout";
import { createWidget, WIDGET_KINDS, widgetKindInfo, WidgetSettings } from "../widgets/registry";

/**
 * The builder's side panel: Add (widget palette), Data (the app's sources),
 * and Widget (the selected widget's inspector) — composed from the shadcn
 * base-ui kit (Item, Field, ToggleGroup, ButtonGroup, Empty, AlertDialog).
 * Every disabled control says why (the "no silent disabled buttons" rule,
 * docs/memory).
 */

export type PanelTab = "add" | "data" | "widget";

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
            This app has the maximum of {APP_LIMITS.widgets} widgets — remove one to add another.
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
                content.widgets.filter((widget) => widgetDatasetIds(widget).includes(datasetId))
                  .length
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

export function BuilderPanel({
  tab,
  onTabChange,
  content,
  selected,
  onUpdate,
  onSelect,
}: {
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  content: AppContent;
  selected: Widget | undefined;
  onUpdate: (change: (prev: AppContent) => AppContent) => void;
  onSelect: (id: string | undefined) => void;
}) {
  const states = useAppDatasets();
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === "add" || value === "data" || value === "widget") {
          onTabChange(value);
        }
      }}
      className="flex h-full flex-col"
    >
      <TabsList className="w-full">
        <TabsTrigger value="add">Add</TabsTrigger>
        <TabsTrigger value="data">Data ({content.datasetIds.length})</TabsTrigger>
        <TabsTrigger value="widget">Widget</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto pt-4">
        <TabsContent value="add">
          <AddPanel
            hasData={content.datasetIds.length > 0}
            full={content.widgets.length >= APP_LIMITS.widgets}
            onAdd={(kind) => {
              const widget = createWidget(kind, content.datasetIds, states);
              onUpdate((prev) => ({ ...prev, widgets: [...prev.widgets, widget] }));
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
                widgets: withoutDataset(prev.widgets, datasetId),
              }));
            }}
          />
        </TabsContent>
        <TabsContent value="widget">
          <WidgetPanel
            widget={selected}
            datasetIds={content.datasetIds}
            onChange={(next) => {
              onUpdate((prev) => ({
                ...prev,
                widgets: prev.widgets.map((widget) => (widget.id === next.id ? next : widget)),
              }));
            }}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}

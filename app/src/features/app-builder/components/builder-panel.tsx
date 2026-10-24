import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Database, EyeOff, Minus, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";

import { DatasetPickerSheet } from "#/components/dataset-picker-sheet";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { cn } from "#/lib/utils";
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
 * and Widget (the selected widget's inspector). Every disabled control says
 * why (the "no silent disabled buttons" rule, docs/memory).
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
        <p className="text-xs text-muted-foreground">
          This app has the maximum of {APP_LIMITS.widgets} widgets — remove one to add another.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {WIDGET_KINDS.map((info) => {
          const Icon = info.icon,
            disabled = full || (info.needsData && !hasData);
          return (
            <button
              key={info.kind}
              type="button"
              disabled={disabled}
              onClick={() => {
                onAdd(info.kind);
              }}
              className="flex flex-col items-start gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-card"
            >
              <Icon className="size-4 text-primary" />
              <span className="text-sm font-medium">{info.label}</span>
              <span className="text-xs text-muted-foreground">{info.description}</span>
            </button>
          );
        })}
      </div>
      {!hasData && (
        <p className="text-xs text-muted-foreground">
          Maps, charts, tables and numbers read from the app's datasets — add one on the Data tab
          first.
        </p>
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
    size = sizeLabel(state);
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            {kind !== undefined && <Badge variant="secondary">{kind}</Badge>}
            {restricted && (
              <Badge variant="outline" title="Only you can see this dataset">
                <EyeOff />
                Only you
              </Badge>
            )}
          </div>
          {state.status === "ready" ? (
            <Link
              to="/datasets/$schemaId"
              params={{ schemaId: datasetId }}
              className="mt-1 block truncate text-sm font-medium hover:underline"
            >
              {state.doc.title}
            </Link>
          ) : (
            <p className="mt-1 truncate text-sm font-medium text-muted-foreground">
              {datasetTitle(state)}
            </p>
          )}
          {size !== undefined && <p className="text-xs text-muted-foreground">{size}</p>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${datasetTitle(state)} from the app`}
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
      </div>
      {restricted && (
        <p className="text-xs text-muted-foreground">
          People you share this app with won't see this dataset's widgets.
        </p>
      )}
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-2 text-xs">
          <span>
            {usedBy} {usedBy === 1 ? "widget uses" : "widgets use"} this dataset and will be removed
            (maps just lose the layer).
          </span>
          <div className="flex gap-2">
            <Button type="button" size="xs" variant="destructive" onClick={onRemove}>
              Remove
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
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
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
          <Database className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">No datasets yet</p>
          <p className="text-xs text-muted-foreground">
            Add one from the catalog to start building.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
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
        </ul>
      )}
      <Button
        type="button"
        disabled={full || summaries === undefined}
        onClick={() => {
          setPickerOpen(true);
        }}
      >
        <Plus />
        {summaries === undefined ? "Loading catalog…" : "Add dataset"}
      </Button>
      {full && (
        <p className="text-xs text-muted-foreground">
          An app holds up to {APP_LIMITS.datasets} datasets.
        </p>
      )}
      <Link
        to="/datasets/create"
        className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Upload className="size-3.5" />
        Import new data into the catalog
      </Link>
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
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Width</legend>
        <div className="grid grid-cols-6 gap-1">
          {WIDTH_PRESETS.map((preset) => (
            <button
              key={preset.w}
              type="button"
              aria-pressed={widget.w === preset.w}
              onClick={() => {
                onChange({ ...widget, w: preset.w });
              }}
              className={cn(
                "h-7 rounded-md border text-xs transition-colors",
                widget.w === preset.w
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Height</span>
        <div className="flex items-center gap-1">
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
          <span className="w-16 text-center text-xs tabular-nums">{widget.h} rows</span>
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
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Or drag a widget's corner on the canvas. Drag its handle to reorder.
      </p>
    </div>
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
      <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Select a widget on the canvas to edit it.
      </p>
    );
  }
  const info = widgetKindInfo(widget.kind),
    Icon = info.icon;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-primary" />
        {info.label}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`widget-title-${widget.id}`}>Title</Label>
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
      </div>
      <WidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />
      <div className="border-t border-border pt-4">
        <SizeControls widget={widget} onChange={onChange} />
      </div>
    </div>
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

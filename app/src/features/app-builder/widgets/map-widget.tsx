import { Loader2 } from "lucide-react";
import { useState } from "react";

import { LayersMap } from "#/components/layers-map";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { useGeometriesBySchemas } from "#/lib/dataset-rows-react";
import { splitSchemaIdsByDecision, useTileArchiveSources } from "#/lib/layer-source";
import { colorForIndex } from "#/lib/map-layers";
import { APP_LIMITS } from "#convex/appBuilder/validators";

import { useAppDatasets, datasetTitle, type DatasetDoc, type DatasetState } from "../data";
import { WidgetMessage, type WidgetSettingsProps, type WidgetViewProps } from "./shared";

/**
 * A map of one or more geospatial datasets — the saved-map workspace's
 * `LayersMap` and its two geometry paths (fresh PMTiles archive, else
 * paginated rows), with one stable color per layer and click-through feature
 * details. The camera fits the layers' stored extents once, at mount; the
 * map is keyed by its layer list so the builder re-fits when layers change.
 */

function isGeospatial(state: DatasetState | undefined): boolean {
  return state !== undefined && state.status === "ready" && state.doc.kind === "geospatial";
}

function withArrived(prev: Set<string>, schemaId: string): Set<string> {
  return prev.has(schemaId) ? prev : new Set(prev).add(schemaId);
}

function LayersBody({ docs, layerOrder }: { docs: DatasetDoc[]; layerOrder: readonly string[] }) {
  const ids = docs.map((doc) => doc._id),
    sourceBySchema = useTileArchiveSources(docs),
    split = splitSchemaIdsByDecision(ids, sourceBySchema),
    { geometries, servedGeometries, loaders } = useGeometriesBySchemas(split.rowSchemaIds),
    [arrived, setArrived] = useState<Set<string>>(() => new Set()),
    // Colors follow the layer's slot in the widget, never its rank among
    // the datasets that happen to be available.
    colorBySchema = new globalThis.Map(
      ids.map((id) => [id, colorForIndex(layerOrder.indexOf(id))]),
    ),
    complete =
      geometries !== undefined &&
      !split.sourcesPending &&
      split.tileSources.every((source) => arrived.has(source.schemaId)),
    // Mount on the first served rows or tile source — or once every pass
    // finished empty — then stay mounted (never re-skeleton a visible map).
    shouldMount =
      servedGeometries !== undefined || split.tileSources.length > 0 || geometries !== undefined;
  return (
    <div className="relative h-full w-full overflow-hidden rounded-b-lg">
      {loaders}
      {shouldMount ? (
        <LayersMap
          datasets={docs}
          geometries={servedGeometries ?? []}
          visibleSchemaIds={new Set(ids)}
          colorBySchema={colorBySchema}
          tileSources={split.tileSources}
          sourcesPending={split.sourcesPending}
          onTileSourceIdle={(schemaId) => {
            setArrived((prev) => withArrived(prev, schemaId));
          }}
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-muted" />
      )}
      {!complete && (
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          Loading features…
        </div>
      )}
    </div>
  );
}

export function MapWidgetView({ widget }: WidgetViewProps<"map">) {
  const states = useAppDatasets(),
    layerStates = widget.datasetIds.map((id) => states.get(id)),
    docs = layerStates.flatMap((state) =>
      state !== undefined && state.status === "ready" && state.doc.kind === "geospatial"
        ? [state.doc]
        : [],
    );
  if (widget.datasetIds.length === 0) {
    return <WidgetMessage>Choose datasets to show on this map.</WidgetMessage>;
  }
  // Wait for every layer's doc: the one-shot camera fit reads their extents.
  if (layerStates.some((state) => state !== undefined && state.status === "loading")) {
    return <WidgetMessage loading>Loading map…</WidgetMessage>;
  }
  if (docs.length === 0) {
    return <WidgetMessage>None of this map's datasets are available to you.</WidgetMessage>;
  }
  return (
    <LayersBody
      key={docs.map((doc) => doc._id).join(",")}
      docs={docs}
      layerOrder={widget.datasetIds}
    />
  );
}

export function MapWidgetSettings({ widget, datasetIds, onChange }: WidgetSettingsProps<"map">) {
  const states = useAppDatasets(),
    candidates = datasetIds.filter((id) => isGeospatial(states.get(id))),
    selected = new Set(widget.datasetIds),
    full = widget.datasetIds.length >= APP_LIMITS.mapDatasets;
  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add a geospatial dataset to the app to put it on a map.
      </p>
    );
  }
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Layers</legend>
      {candidates.map((id) => (
        <Label key={id} className="flex items-center gap-2 font-normal">
          <Checkbox
            checked={selected.has(id)}
            disabled={!selected.has(id) && full}
            onCheckedChange={(checked) => {
              // Keep the app's dataset order as the layer order.
              const next = candidates.filter((candidate) =>
                candidate === id ? checked : selected.has(candidate),
              );
              onChange({ ...widget, datasetIds: next });
            }}
          />
          <span
            className="size-2.5 shrink-0 rounded-full border border-border"
            style={{
              backgroundColor: selected.has(id)
                ? colorForIndex(widget.datasetIds.indexOf(id))
                : "transparent",
            }}
          />
          <span className="truncate">
            {datasetTitle(states.get(id) ?? { status: "unavailable" })}
          </span>
        </Label>
      ))}
      {full && (
        <p className="text-xs text-muted-foreground">
          A map shows up to {APP_LIMITS.mapDatasets} datasets.
        </p>
      )}
    </fieldset>
  );
}

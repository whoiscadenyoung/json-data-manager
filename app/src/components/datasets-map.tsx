import { buildFeatureCollection, computeBbox, useResolvedGeometries } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { Map as MapIcon, X } from "lucide-react";
import { Fragment, useState } from "react";

import { formatPropertyValue } from "#/components/entries-map";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Map, MapClusterLayer, MapGeoJSON } from "#/components/ui/map";
import { buildPointFeatureCollection, splitPointLikeGeometries } from "#/lib/point-geometry";
import { api } from "#convex/_generated/api";

// There is no server-side "all geometries in this collection" query — see
// the collection detail route's `SchemaGeometriesLoader` doc comment for
// why (Convex allows at most one `.paginate()` call per query execution).
// The caller fetches each geospatial schema's geometries separately (via
// the paginated `listGeometries`) and merges them into one flat array
// before passing it down here — this type just describes one of those
// already-merged rows.
type GeometryEntry = FunctionReturnType<typeof api.geometries.list>["page"][number];
type EntryDoc = FunctionReturnType<typeof api.collections.listEntriesByCollection>[number];
type Dataset = FunctionReturnType<typeof api.schemas.list>[number];

type FeatureProperties = { entryId: string; schemaId: string };

// Cycled per dataset so each shows up as a distinct color on the map/legend.
const DATASET_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

function colorForIndex(index: number) {
  return DATASET_COLORS[index % DATASET_COLORS.length];
}

function groupGeometriesBySchema(geometries: GeometryEntry[]) {
  const bySchema = new globalThis.Map<string, GeometryEntry[]>();
  for (const geometry of geometries) {
    const existing = bySchema.get(geometry.schemaId);
    if (existing) {
      existing.push(geometry);
    } else {
      bySchema.set(geometry.schemaId, [geometry]);
    }
  }
  return bySchema;
}

/** Falls back to `fallback` when the dataset isn't found — avoids an optional-chained `?.title`. */
function getDatasetTitle(
  datasetById: globalThis.Map<string, Dataset>,
  schemaId: string,
  fallback: string,
) {
  const dataset = datasetById.get(schemaId);
  return dataset ? dataset.title : fallback;
}

function FeatureDetailsPanel({
  entry,
  datasetTitle,
  onClose,
}: {
  entry: EntryDoc;
  datasetTitle: string;
  onClose: () => void;
}) {
  const fields = Object.entries(entry.data as Record<string, unknown>);

  return (
    <div className="absolute top-3 right-3 bottom-3 z-10 flex w-64 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">Feature details</h3>
          <p className="truncate text-xs text-muted-foreground">{datasetTitle}</p>
        </div>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <dl className="flex-1 space-y-3 overflow-y-auto p-3">
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No properties on this entry.</p>
        ) : (
          fields.map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
              <dd className="text-sm break-words">{formatPropertyValue(value)}</dd>
            </div>
          ))
        )}
      </dl>
    </div>
  );
}

/** One color-coded legend swatch per dataset that actually has geometry on the map. */
function MapLegend({ datasets }: { datasets: { schemaId: string; title: string; color: string }[] }) {
  if (datasets.length < 2) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-3">
      {datasets.map((dataset) => (
        <div key={dataset.schemaId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: dataset.color }}
          />
          <span className="truncate">{dataset.title}</span>
        </div>
      ))}
    </div>
  );
}

/** Builds a map-renderable feature row given its already-resolved `Geometry` (see `useResolvedGeometries`). */
function toFeatureRow(geometry: GeometryEntry, resolved: Geometry) {
  return {
    id: geometry.entryId,
    geometry: resolved,
    properties: { entryId: geometry.entryId, schemaId: geometry.schemaId },
  };
}

/**
 * A combined map view across multiple datasets — one color-coded `MapGeoJSON`
 * layer per dataset, all sharing a single viewport fit to their union bbox.
 * Used for the group/collection-level "all datasets" map, unlike `EntriesMap`
 * which renders a single dataset.
 */
export function DatasetsMap({
  datasets,
  geometries,
  entries,
}: {
  datasets: Dataset[];
  geometries: GeometryEntry[];
  entries: EntryDoc[];
}) {
  const entryById = new globalThis.Map(entries.map((entry) => [entry._id, entry])),
    datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    resolvedGeometries = useResolvedGeometries(geometries),
    // Most rows resolve synchronously (inline `geometryJson`); a row backed
    // by external storage is simply absent until its `fetch` completes.
    // (Left for React Compiler's own automatic memoization rather than a
    // manual `useMemo` here — `resolvedGeometries` is a `Map`, whose
    // reference identity the compiler can't statically prove is stable
    // against a hand-written dependency array.)
    resolvableGeometries = geometries.flatMap((g) => {
      const resolved = resolvedGeometries.get(g._id);
      return resolved === undefined ? [] : [{ g, resolved }];
    }),
    geometriesBySchema = groupGeometriesBySchema(resolvableGeometries.map(({ g }) => g)),
    schemaIds = [...geometriesBySchema.keys()],
    resolvedById = new globalThis.Map(resolvableGeometries.map(({ g, resolved }) => [g._id, resolved])),
    [selected, setSelected] = useState<FeatureProperties | null>(null);

  if (geometries.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapIcon />
          </EmptyMedia>
          <EmptyTitle>No geometry yet</EmptyTitle>
          <EmptyDescription>
            Geospatial datasets here will appear together on the map.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const combined = buildFeatureCollection<FeatureProperties>(
      resolvableGeometries.map(({ g, resolved }) => toFeatureRow(g, resolved)),
    ),
    bbox = computeBbox(combined),
    legendDatasets = schemaIds.map((schemaId, index) => ({
      schemaId,
      title: getDatasetTitle(datasetById, schemaId, "Untitled dataset"),
      color: colorForIndex(index),
    })),
    selectedEntry = selected ? entryById.get(selected.entryId) : undefined,
    selectedDatasetTitle = selected ? getDatasetTitle(datasetById, selected.schemaId, "") : "";

  return (
    <div className="flex flex-col gap-3">
      <MapLegend datasets={legendDatasets} />
      <div className="relative h-[500px] w-full overflow-hidden rounded-lg border border-border">
        <Map bounds={bbox} className="h-full w-full">
          {schemaIds.map((schemaId, index) => {
            const color = colorForIndex(index),
              schemaGeometries = geometriesBySchema.get(schemaId) ?? [],
              // `MapGeoJSON` renders `fill`/`line` layers, which draw nothing
              // for Point/MultiPoint geometries — those go to
              // `MapClusterLayer` instead, which renders `circle` layers.
              { pointRows, otherRows } = splitPointLikeGeometries(schemaGeometries),
              withResolved = (rows: GeometryEntry[]) =>
                rows.flatMap((g) => {
                  const resolved = resolvedById.get(g._id);
                  return resolved === undefined ? [] : [toFeatureRow(g, resolved)];
                }),
              otherCollection = buildFeatureCollection<FeatureProperties>(withResolved(otherRows)),
              pointCollection = buildPointFeatureCollection<FeatureProperties>(
                withResolved(pointRows),
              ),
              handleFeatureSelect = (properties: FeatureProperties) => {
                setSelected(properties);
              };
            return (
              <Fragment key={schemaId}>
                {otherCollection.features.length > 0 && (
                  <MapGeoJSON<FeatureProperties>
                    data={otherCollection}
                    interactive
                    fillPaint={{ "fill-color": color, "fill-opacity": 0.2 }}
                    linePaint={{ "line-color": color, "line-width": 2 }}
                    fillHoverPaint={{ "fill-opacity": 0.35 }}
                    onClick={(e) => handleFeatureSelect(e.feature.properties)}
                  />
                )}
                {pointCollection.features.length > 0 && (
                  <MapClusterLayer<FeatureProperties>
                    data={pointCollection}
                    pointColor={color}
                    clusterColors={[color, color, color]}
                    onPointClick={(feature) => handleFeatureSelect(feature.properties)}
                  />
                )}
              </Fragment>
            );
          })}
        </Map>
        {selectedEntry && (
          <FeatureDetailsPanel
            entry={selectedEntry}
            datasetTitle={selectedDatasetTitle}
            onClose={() => {
              setSelected(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

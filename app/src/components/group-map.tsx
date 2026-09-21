import {
  buildFeatureCollection,
  computeBbox,
  useResolvedGeometries,
  unionBbox,
} from "@caden/json-cms/react";
import type { BoundingBox, Geometry } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { ChevronRight, X } from "lucide-react";
import { Fragment, useState } from "react";

import type { GeometryEntry } from "#/components/schema-geometries-loader";
import { Button } from "#/components/ui/button";
import { Map, MapClusterLayer, MapGeoJSON, MapVectorTiles } from "#/components/ui/map";
import { formatPropertyValue } from "#/lib/format";
import {
  asBoundingBox,
  bboxFeature,
  buildPointFeatureCollection,
  splitPointLikeGeometries,
} from "#/lib/point-geometry";

type EntryDoc = FunctionReturnType<typeof api.entries.listEntriesForSchemas>[number];
type Dataset = FunctionReturnType<typeof api.schemas.listSummaries>[number];

import { api } from "#convex/_generated/api";

type FeatureProperties = { entryId: string; schemaId: string };

// Dashed rectangle framing the group's whole extent, matching the dataset
// map's outline styling. Drawn under the data layers, never interactive.
const EXTENT_LINE_PAINT = {
  "line-color": "#3b82f6",
  "line-width": 1.5,
  "line-dasharray": [2, 1.5],
};

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
  const data: Record<string, unknown> = entry.data,
    fields = Object.entries(data);

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
      <Link
        to="/datasets/$schemaId/$entryId"
        params={{ schemaId: entry.schemaId, entryId: entry._id }}
        className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2 text-xs font-medium text-primary hover:bg-muted/50"
      >
        View details
        <ChevronRight className="size-3" />
      </Link>
    </div>
  );
}

/** One color-coded legend swatch per dataset that actually has geometry on the map. */
function MapLegend({
  datasets,
}: {
  datasets: { schemaId: string; title: string; color: string }[];
}) {
  if (datasets.length < 2) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-3">
      {datasets.map((dataset) => (
        <div
          key={dataset.schemaId}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
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
 * A combined feature-layer map across a group of datasets: every entry's
 * geometry rendered directly (shapes via fill/line layers, points as
 * individual circles), one color per dataset, viewport fit to their union.
 * Clicking a feature opens its entry's properties — so the group reads as
 * one layer of data, the way a single dataset's map does.
 *
 * Above-threshold datasets with a fresh tile archive (issue #58 part 4)
 * arrive as `tileSources` and render via `MapVectorTiles` with the same
 * per-dataset color; tile features carry id-only properties (`entryId`), and
 * their viewport contribution to the fit comes from the datasets' stored
 * `boundingBox` extents rather than any geometry rows.
 */
export function GroupMap({
  datasets,
  geometries,
  entries,
  tileSources,
}: {
  datasets: Dataset[];
  geometries: GeometryEntry[];
  entries: EntryDoc[];
  /** Above-threshold datasets rendering from their fresh tile archive. */
  tileSources: Array<{ schemaId: string; url: string }>;
}) {
  const entryById = new globalThis.Map(entries.map((entry) => [entry._id, entry])),
    datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    resolvedGeometries = useResolvedGeometries(geometries),
    // Most rows resolve synchronously (inline `geometryJson`); a row backed
    // by external storage is simply absent until its `fetch` completes.
    resolvableGeometries = geometries.flatMap((g) => {
      const resolved = resolvedGeometries.get(g._id);
      return resolved === undefined ? [] : [{ g, resolved }];
    });

  const bySchema = new globalThis.Map<string, GeometryEntry[]>();
  for (const geometry of resolvableGeometries.map(({ g }) => g)) {
    const existing = bySchema.get(geometry.schemaId);
    if (existing) {
      existing.push(geometry);
    } else {
      bySchema.set(geometry.schemaId, [geometry]);
    }
  }
  // Row-path schemas with geometry plus the tile-path sources, in one stable
  // order so each dataset's color index is deterministic across renders.
  const schemaIds = [...new Set([...bySchema.keys(), ...tileSources.map((s) => s.schemaId)])],
    resolvedById = new globalThis.Map(
      resolvableGeometries.map(({ g, resolved }) => [g._id, resolved]),
    ),
    [selected, setSelected] = useState<FeatureProperties | null>(null);

  if (resolvableGeometries.length === 0 && tileSources.length === 0) {
    return null;
  }

  const combined = buildFeatureCollection<FeatureProperties>(
      resolvableGeometries.map(({ g, resolved }) => toFeatureRow(g, resolved)),
    ),
    // The tile path contributes no rows — its viewport coverage is the
    // datasets' stored `boundingBox` extents (same stored-envelope caveat as
    // every other consumer: only ever stale-wider, never stale-smaller).
    tileBbox = tileSources.reduce<BoundingBox | undefined>((acc, source) => {
      const dataset = datasetById.get(source.schemaId);
      return dataset === undefined ? acc : unionBbox(acc, asBoundingBox(dataset.boundingBox));
    }, undefined),
    bbox = unionBbox(computeBbox(combined), tileBbox),
    legendDatasets = schemaIds.map((schemaId, index) => ({
      schemaId,
      title: getDatasetTitle(datasetById, schemaId, "Untitled dataset"),
      color: colorForIndex(index),
    })),
    selectedEntry = selected ? entryById.get(selected.entryId) : undefined,
    selectedDatasetTitle = selected ? getDatasetTitle(datasetById, selected.schemaId, "") : "";

  if (bbox === undefined) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <MapLegend datasets={legendDatasets} />
      <div className="relative h-[500px] w-full overflow-hidden rounded-lg border border-border">
        <Map bounds={bbox} className="h-full w-full">
          {/* Dashed outline framing the group's whole extent, under the data
              layers — same treatment as a single dataset's map. */}
          <MapGeoJSON
            data={bboxFeature(bbox)}
            id="group-extent"
            fillPaint={false}
            linePaint={EXTENT_LINE_PAINT}
          />
          {schemaIds.map((schemaId, index) => {
            const color = colorForIndex(index),
              tileSource = tileSources.find((source) => source.schemaId === schemaId);
            if (tileSource !== undefined) {
              return (
                <MapVectorTiles<{ entryId: string }>
                  key={schemaId}
                  id={`group-tiles-${schemaId}`}
                  url={tileSource.url}
                  interactive
                  fillPaint={{ "fill-color": color, "fill-opacity": 0.2 }}
                  linePaint={{ "line-color": color, "line-width": 2 }}
                  fillHoverPaint={{ "fill-opacity": 0.35 }}
                  onClick={(e) => {
                    // Tiles carry id-only properties — the entry id is the
                    // join key; the dataset is known from this layer's wiring.
                    setSelected({ entryId: e.feature.properties.entryId, schemaId });
                  }}
                />
              );
            }
            const schemaGeometries = bySchema.get(schemaId) ?? [],
              // `MapGeoJSON` renders `fill`/`line` layers, which draw nothing
              // for Point/MultiPoint geometries — those go to
              // `MapClusterLayer` instead, which renders `circle` layers
              // (unclustered by default since #27).
              { pointRows, otherRows } = splitPointLikeGeometries(schemaGeometries),
              withResolved = (rows: GeometryEntry[]) =>
                rows.flatMap((g) => {
                  const resolved = resolvedById.get(g._id);
                  return resolved === undefined ? [] : [toFeatureRow(g, resolved)];
                }),
              otherCollection = buildFeatureCollection<FeatureProperties>(withResolved(otherRows)),
              pointCollection = buildPointFeatureCollection<FeatureProperties>(
                withResolved(pointRows),
              );
            return (
              <Fragment key={schemaId}>
                {otherCollection.features.length > 0 && (
                  <MapGeoJSON<FeatureProperties>
                    data={otherCollection}
                    interactive
                    fillPaint={{ "fill-color": color, "fill-opacity": 0.2 }}
                    linePaint={{ "line-color": color, "line-width": 2 }}
                    fillHoverPaint={{ "fill-opacity": 0.35 }}
                    onClick={(e) => {
                      setSelected(e.feature.properties);
                    }}
                  />
                )}
                {pointCollection.features.length > 0 && (
                  <MapClusterLayer<FeatureProperties>
                    data={pointCollection}
                    pointColor={color}
                    onPointClick={(feature) => {
                      setSelected(feature.properties);
                    }}
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

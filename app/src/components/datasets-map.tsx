import { buildFeatureCollection, computeBbox, useResolvedGeometries } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { Map as MapIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Map, MapGeoJSON } from "#/components/ui/map";
import { bboxFeature } from "#/lib/point-geometry";
import { api } from "#convex/_generated/api";

// There is no server-side "all geometries in this collection" query — see
// the collection detail route's `SchemaGeometriesLoader` doc comment for
// why (Convex allows at most one `.paginate()` call per query execution).
// The caller fetches each geospatial schema's geometries separately (via
// the paginated `listGeometries`) and merges them into one flat array
// before passing it down here — this type just describes one of those
// already-merged rows.
type GeometryEntry = FunctionReturnType<typeof api.geometries.list>["page"][number];
type Dataset = FunctionReturnType<typeof api.schemas.list>[number];

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

function toFeatureRow(geometry: GeometryEntry, resolved: Geometry) {
  return {
    id: geometry.entryId,
    geometry: resolved,
    properties: {},
  };
}

/**
 * A quiet, extent-only view of a collection's geospatial datasets: one
 * dashed color-coded rectangle per dataset framing its bounding box, with
 * the viewport fit to their combined extent. Renders no individual features
 * — this sits above the collection's dataset list (a full feature map lives
 * on each dataset's own page).
 */
export function CollectionExtentMap({
  datasets,
  geometries,
}: {
  datasets: Dataset[];
  geometries: GeometryEntry[];
}) {
  const datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    resolvedGeometries = useResolvedGeometries(geometries),
    // Most rows resolve synchronously (inline `geometryJson`); a row backed
    // by external storage is simply absent until its `fetch` completes.
    resolvableGeometries = geometries.flatMap((g) => {
      const resolved = resolvedGeometries.get(g._id);
      return resolved === undefined ? [] : [{ g, resolved }];
    }),
    geometriesBySchema = groupGeometriesBySchema(resolvableGeometries.map(({ g }) => g)),
    schemaIds = [...geometriesBySchema.keys()],
    resolvedById = new globalThis.Map(
      resolvableGeometries.map(({ g, resolved }) => [g._id, resolved]),
    );

  if (resolvableGeometries.length === 0) {
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

  const combined = buildFeatureCollection(
      resolvableGeometries.map(({ g, resolved }) => toFeatureRow(g, resolved)),
    ),
    combinedBbox = computeBbox(combined),
    legendDatasets = schemaIds.map((schemaId, index) => ({
      schemaId,
      title: getDatasetTitle(datasetById, schemaId, "Untitled dataset"),
      color: colorForIndex(index),
    })),
    // One dashed extent rectangle per dataset — skipped entirely when its
    // geometries somehow have no determinable coordinates.
    extents = schemaIds.flatMap((schemaId, index) => {
      const rows = geometriesBySchema.get(schemaId) ?? [],
        bbox = computeBbox(
          buildFeatureCollection(
            rows.flatMap((g) => {
              const resolved = resolvedById.get(g._id);
              return resolved === undefined ? [] : [toFeatureRow(g, resolved)];
            }),
          ),
        );
      return bbox === undefined
        ? []
        : [
            {
              schemaId,
              feature: bboxFeature(bbox),
              color: colorForIndex(index),
            },
          ];
    });

  if (combinedBbox === undefined) {
    return null;
  }

  return (
    <div className="flex h-full w-full flex-col gap-3">
      <MapLegend datasets={legendDatasets} />
      <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-lg border border-border">
        <Map bounds={combinedBbox} className="h-full w-full">
          {extents.map((extent) => (
            <MapGeoJSON
              key={extent.schemaId}
              id={`collection-extent-${extent.schemaId}`}
              data={extent.feature}
              fillPaint={false}
              linePaint={{
                "line-color": extent.color,
                "line-width": 2,
                "line-dasharray": [2, 1.5],
              }}
            />
          ))}
        </Map>
      </div>
    </div>
  );
}

import { unionBbox } from "@caden/json-cms/react";
import type { BoundingBox } from "@caden/json-cms/react";
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
import { asBoundingBox, bboxFeature } from "#/lib/point-geometry";
import { api } from "#convex/_generated/api";

type Dataset = FunctionReturnType<typeof api.schemas.listSummaries>[number];

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

/** One color-coded legend swatch per dataset that has an extent on the map. */
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

/**
 * A quiet, extent-only view of a collection's geospatial datasets: one
 * dashed color-coded rectangle per dataset framing its bounding box, with
 * the viewport fit to their combined extent. Renders no individual features
 * — this sits above the collection's dataset list (a full feature map lives
 * on each dataset's own page).
 *
 * The rectangles come straight from each dataset's server-maintained
 * `schemas.boundingBox`, so this renders with zero geometry loads — no
 * `listGeometries` traffic at all, where drawing the same rectangles from
 * resolved payloads used to page through every dataset's full geometry rows
 * (57 serial round trips for one measured real dataset). The stored extent
 * is a best-effort envelope that only ever grows (deletions don't shrink
 * it) — accepted here the same way the dataset page accepts it, since this
 * map only ever draws extent rectangles and a default viewport, never
 * exact features.
 */
export function CollectionExtentMap({ datasets }: { datasets: Dataset[] }) {
  const datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    // One entry per dataset that has a stored extent — the only thing this
    // map can draw. A geospatial dataset without one has no geometry yet.
    extents = datasets.flatMap((dataset) => {
      const bbox = asBoundingBox(dataset.boundingBox);
      return bbox === undefined ? [] : [{ schemaId: dataset._id, bbox }];
    }),
    framedExtents = extents.map(({ schemaId, bbox }, index) => ({
      bbox,
      color: colorForIndex(index),
      feature: bboxFeature(bbox),
      schemaId,
    })),
    // The combined viewport = union of the stored boxes (same `unionBbox`
    // the component uses to grow each dataset's own `boundingBox`).
    combinedBbox = extents.reduce<BoundingBox | undefined>(
      (acc, extent) => unionBbox(acc, extent.bbox),
      undefined,
    ),
    legendDatasets = framedExtents.map(({ schemaId, color }) => ({
      schemaId,
      title: getDatasetTitle(datasetById, schemaId, "Untitled dataset"),
      color,
    }));

  if (framedExtents.length === 0) {
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

  return (
    <div className="flex h-full w-full flex-col gap-3">
      <MapLegend datasets={legendDatasets} />
      <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-lg border border-border">
        <Map bounds={combinedBbox} className="h-full w-full">
          {framedExtents.map((extent) => (
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

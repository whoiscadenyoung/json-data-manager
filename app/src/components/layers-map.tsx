import { buildFeatureCollection, unionBbox, useResolvedGeometries } from "@caden/json-cms/react";
import type { BoundingBox, Geometry } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, X } from "lucide-react";
import { Fragment, useState } from "react";

import { Button } from "#/components/ui/button";
import { Map, MapClusterLayer, MapGeoJSON, MapVectorTiles } from "#/components/ui/map";
import type { DatasetEntryRow, DatasetGeometryRow } from "#/lib/dataset-rows";
import { useDatasetEntryRow } from "#/lib/dataset-rows-react";
import { formatPropertyValue } from "#/lib/format";
import type { DatasetSummary } from "#/lib/map-layers";
import {
  asBoundingBox,
  buildPointFeatureCollection,
  splitPointLikeGeometries,
} from "#/lib/point-geometry";

type EntryDoc = DatasetEntryRow;

// Layer rows come from the seam's fan-out (`useGeometriesBySchemas`).
type GeometryEntry = DatasetGeometryRow;

type FeatureProperties = { entryId: string; schemaId: string };

function FeatureDetailsPanel({
  entry,
  entryId,
  schemaId,
  datasetTitle,
  onClose,
}: {
  /** `undefined` while the on-demand read is in flight, `null` if the entry is gone. */
  entry: EntryDoc | null | undefined;
  entryId: string;
  schemaId: string;
  datasetTitle: string;
  onClose: () => void;
}) {
  const data = entry !== null && entry !== undefined ? entry.data : undefined,
    fields =
      typeof data === "object" && data !== null && !Array.isArray(data) ? Object.entries(data) : [];

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
        {entry === undefined ? (
          <dd className="text-sm text-muted-foreground">Loading properties…</dd>
        ) : entry === null ? (
          <dd className="text-sm text-muted-foreground">This entry no longer exists.</dd>
        ) : fields.length === 0 ? (
          <dd className="text-sm text-muted-foreground">No properties on this entry.</dd>
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
        params={{ schemaId, entryId }}
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
    <div className="bg-card/90 absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-x-3 gap-y-1 rounded-lg border border-border p-2 shadow-sm backdrop-blur-sm">
      {datasets.map((dataset) => (
        <div
          key={dataset.schemaId}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: dataset.color }}
          />
          <span className="max-w-40 truncate">{dataset.title}</span>
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

/** Falls back to `fallback` when the dataset isn't found — avoids an optional-chained `?.title`. */
function getDatasetTitle(
  datasetById: globalThis.Map<string, DatasetSummary>,
  schemaId: string,
  fallback: string,
) {
  const dataset = datasetById.get(schemaId);
  return dataset ? dataset.title : fallback;
}

/**
 * The combined map of a saved map's layers: every visible layer's geometries
 * rendered directly (shapes via fill/line layers, points as individual
 * circles), one stable color per dataset — geometries only, no extent
 * rectangles. Clicking a feature opens its entry's properties. Geometry rows
 * arrive for ALL layers (visible or not) so toggling a layer on is instant;
 * rows are filtered to `visibleSchemaIds` at render time.
 *
 * Above-threshold datasets with a fresh tile archive (issue #58 part 4)
 * arrive as `tileSources` instead of rows: each renders a `MapVectorTiles`
 * layer with the same per-dataset color, and visibility rides the layout
 * property so toggling show/hide keeps the source + its tile cache warm.
 * Tile features carry id-only properties (`entryId`), so both paths click
 * through the same `{entryId, schemaId}` pair.
 *
 * Entry properties load on demand (issue #52): clicking a feature starts one
 * indexed single-entry read (`entries.get`), subscribed — and live — only
 * while the popup is open. The map's first paint no longer pays an
 * O(total mapped rows) entries fetch that existed just to power this panel.
 *
 * The viewport fits exactly once, when the component mounts (the parent
 * mounts it as soon as the first layer's rows complete or the first tile
 * source is ready): the bounds are captured from the layers' datasets' stored
 * `boundingBox` extents via a lazy initializer and never change afterwards.
 * Hiding or showing layers (or any of their datasets), adding or removing
 * layers, or late-resolving payloads never moves the camera again; a fresh
 * page load re-fits.
 */
export function LayersMap({
  datasets,
  geometries,
  visibleSchemaIds,
  colorBySchema,
  tileSources,
  sourcesPending = false,
  onTileSourceIdle,
}: {
  datasets: DatasetSummary[];
  geometries: GeometryEntry[];
  visibleSchemaIds: Set<string>;
  colorBySchema: globalThis.Map<string, string>;
  /** Above-threshold datasets rendering from their fresh tile archive. */
  tileSources: Array<{ schemaId: string; url: string }>;
  /** True while any layer's source decision is still resolving (suppresses the "nothing to draw" overlay). */
  sourcesPending?: boolean;
  /** Fired once per tile source, after it loaded and the map reached `idle`. */
  onTileSourceIdle?: (schemaId: string) => void;
}) {
  const datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    resolvedGeometries = useResolvedGeometries(geometries),
    // Most rows resolve synchronously (inline `geometryJson`); a row backed
    // by external storage is simply absent until its `fetch` completes.
    visibleGeometries = geometries.flatMap((g) => {
      if (!visibleSchemaIds.has(g.schemaId)) {
        return [];
      }
      const resolved = resolvedGeometries.get(g._id);
      return resolved === undefined ? [] : [{ g, resolved }];
    }),
    // Captured exactly once, at mount — but from each dataset's
    // server-maintained `schemas.boundingBox`, NOT the served rows' per-row
    // envelopes: the map mounts as soon as the FIRST schema's pagination
    // completes while the rest still stream, so row-derived bounds would
    // understate the extent and strand late-arriving features outside the
    // viewport. The stored extents are complete the moment layers resolve,
    // so the one fit-bounds is right from the start. Caveat (same
    // everywhere): stored envelopes only grow (deletions never shrink
    // them) — fine for a default viewport.
    [initialBounds] = useState(() => {
      let bbox: BoundingBox | undefined;
      for (const dataset of datasets) {
        bbox = unionBbox(bbox, asBoundingBox(dataset.boundingBox));
      }
      return bbox;
    }),
    [selected, setSelected] = useState<FeatureProperties | null>(null),
    // The clicked feature's entry, read on demand through the seam's
    // point-read path (issue #52): one indexed single-doc subscription per
    // selection, live only while the popup is open. Re-selecting the same
    // feature re-subscribes without a client-side fetch of anything else;
    // closing drops the subscription.
    selectedEntry = useDatasetEntryRow(selected !== null ? selected.entryId : undefined),
    selectedDatasetTitle = selected ? getDatasetTitle(datasetById, selected.schemaId, "") : "";

  const bySchema = new globalThis.Map<string, GeometryEntry[]>();
  for (const { g } of visibleGeometries) {
    const existing = bySchema.get(g.schemaId);
    if (existing) {
      existing.push(g);
    } else {
      bySchema.set(g.schemaId, [g]);
    }
  }
  // Every dataset with something on the map right now: row-path schemas with
  // geometry, plus the tile-path sources — in a stable order for the legend.
  const schemaIds = [...new Set([...bySchema.keys(), ...tileSources.map((s) => s.schemaId)])],
    resolvedById = new globalThis.Map(
      visibleGeometries.map(({ g, resolved }) => [g._id, resolved]),
    ),
    legendDatasets = schemaIds
      .filter(
        (schemaId) =>
          bySchema.has(schemaId) ||
          (tileSources.some((source) => source.schemaId === schemaId) &&
            visibleSchemaIds.has(schemaId)),
      )
      .map((schemaId) => ({
        schemaId,
        title: getDatasetTitle(datasetById, schemaId, "Untitled dataset"),
        color: colorBySchema.get(schemaId) ?? "#3b82f6",
      })),
    visibleTileSources = tileSources.filter((source) =>
      visibleSchemaIds.has(source.schemaId),
    ).length;

  return (
    <div className="relative h-full w-full">
      <Map bounds={initialBounds} className="h-full w-full">
        {schemaIds.map((schemaId) => {
          const color = colorBySchema.get(schemaId) ?? "#3b82f6",
            tileSource = tileSources.find((source) => source.schemaId === schemaId);
          if (tileSource !== undefined) {
            return (
              <MapVectorTiles<{ entryId: string }>
                key={schemaId}
                id={`layer-tiles-${schemaId}`}
                url={tileSource.url}
                visible={visibleSchemaIds.has(schemaId)}
                interactive
                fillPaint={{ "fill-color": color, "fill-opacity": 0.2 }}
                linePaint={{ "line-color": color, "line-width": 2 }}
                fillHoverPaint={{ "fill-opacity": 0.35 }}
                onIdle={() => {
                  if (onTileSourceIdle !== undefined) {
                    onTileSourceIdle(schemaId);
                  }
                }}
                onClick={(e) => {
                  // Tiles carry id-only properties — the entry id is the join
                  // key; the dataset is known from this layer's wiring.
                  setSelected({ entryId: e.feature.properties.entryId, schemaId });
                }}
              />
            );
          }
          const schemaGeometries = bySchema.get(schemaId) ?? [],
            // `MapGeoJSON` renders `fill`/`line` layers, which draw nothing
            // for Point/MultiPoint geometries — those go to `MapClusterLayer`
            // instead, which renders `circle` layers.
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
                  onClick={(e) => {
                    handleFeatureSelect(e.feature.properties);
                  }}
                />
              )}
              {pointCollection.features.length > 0 && (
                <MapClusterLayer<FeatureProperties>
                  data={pointCollection}
                  pointColor={color}
                  onPointClick={(feature) => {
                    handleFeatureSelect(feature.properties);
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </Map>
      {visibleGeometries.length === 0 && visibleTileSources === 0 && !sourcesPending && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/40 p-6 text-center backdrop-blur-[1px]">
          <p className="text-sm text-muted-foreground">
            Nothing to draw — every visible layer is empty or its datasets have no features.
          </p>
        </div>
      )}
      <MapLegend datasets={legendDatasets} />
      {selected && (
        <FeatureDetailsPanel
          entry={selectedEntry}
          entryId={selected.entryId}
          schemaId={selected.schemaId}
          datasetTitle={selectedDatasetTitle}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

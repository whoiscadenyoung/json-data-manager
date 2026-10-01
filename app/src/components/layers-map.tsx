import { buildFeatureCollection, unionBbox, useResolvedGeometries } from "@caden/json-cms/react";
import type { BoundingBox, Geometry } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Loader2, X } from "lucide-react";
import { Fragment, useState } from "react";

import { Button } from "#/components/ui/button";
import { Map, MapClusterLayer, MapGeoJSON, MapVectorTiles } from "#/components/ui/map";
import type { DatasetEntryRow, DatasetGeometryRow } from "#/lib/dataset-rows";
import { useEnrichedDatasetEntryRow } from "#/lib/dataset-rows-react";
import { formatPropertyValue } from "#/lib/format";
import type { DatasetSummary } from "#/lib/map-layers";
import { keyedGeometryRows, toFeatureRow } from "#/lib/map-layers";
import type { KeyedGeometryEntry } from "#/lib/map-layers";
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
  joinedPending,
  onClose,
}: {
  /** `undefined` while the on-demand read is in flight, `null` if the entry is gone. */
  entry: EntryDoc | null | undefined;
  entryId: string;
  schemaId: string;
  datasetTitle: string;
  /** True while the popup executor's spec/lookup-row reads are still streaming (issue #97). */
  joinedPending: boolean;
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
        <Button
          aria-label="Close feature details"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <dl className="flex-1 space-y-3 overflow-y-auto p-3">
        {entry === undefined ? (
          <dd className="text-sm text-muted-foreground">Loading properties…</dd>
        ) : entry === null ? (
          <dd className="text-sm text-muted-foreground">This entry no longer exists.</dd>
        ) : (
          <>
            {fields.length === 0 ? (
              <dd className="text-sm text-muted-foreground">No properties on this entry.</dd>
            ) : (
              // Base properties first, then any saved transform's joined
              // fields as `<namespace>.<field>` keys (issue #97) — an
              // unmatched key renders as null ("—"), never an error and
              // never a dropped popup.
              fields.map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
                  <dd className="text-sm break-words">{formatPropertyValue(value)}</dd>
                </div>
              ))
            )}
            {joinedPending && (
              <dd className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading joined fields…
              </dd>
            )}
          </>
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

/** Falls back to `fallback` when neither title map has the id — avoids an optional-chained `?.title`. */
function getDatasetTitle(
  datasetById: globalThis.Map<string, DatasetSummary>,
  titlesById: globalThis.Map<string, string> | undefined,
  schemaId: string,
  fallback: string,
) {
  if (titlesById !== undefined) {
    const titled = titlesById.get(schemaId);
    if (titled !== undefined) {
      return titled;
    }
  }
  const dataset = datasetById.get(schemaId);
  return dataset ? dataset.title : fallback;
}

/** The stable empty list behind LayersMap's `derivedLayers` default (the default-prop rule). */
const NO_DERIVED_LAYERS: Array<{ derivedId: string; sourceSchemaId: string }> = [];

/** The stable empty list behind LayersMap's `chainLayers` default (the default-prop rule). */
const NO_CHAIN_LAYERS: Array<{ renderId: string; sourceSchemaId: string }> = [];

/** A derived layer's source id → the derived ids drawing it (multi-layer sharing of one source). */
function derivedIdsBySourceOf(
  derivedLayers: Array<{ derivedId: string; sourceSchemaId: string }>,
): globalThis.Map<string, string[]> {
  const bySource = new globalThis.Map<string, string[]>();
  for (const layer of derivedLayers) {
    const ids = bySource.get(layer.sourceSchemaId);
    if (ids === undefined) {
      bySource.set(layer.sourceSchemaId, [layer.derivedId]);
    } else {
      ids.push(layer.derivedId);
    }
  }
  return bySource;
}

/** The 7b chain map: resolved row id → the render ids drawing it (render id → source, inverted once). */
function chainSourceByRenderIdOf(
  chainLayers: Array<{ renderId: string; sourceSchemaId: string }>,
): globalThis.Map<string, string> {
  const byRender = new globalThis.Map<string, string>();
  for (const layer of chainLayers) {
    byRender.set(layer.renderId, layer.sourceSchemaId);
  }
  return byRender;
}

/** Groups the visible, resolved rows by their render id (a derived id for re-keyed copies) — the per-dataset layering order. */
function geometryRowsBySchema(
  visibleGeometries: Array<{ g: KeyedGeometryEntry; resolved: Geometry }>,
): globalThis.Map<string, KeyedGeometryEntry[]> {
  const bySchema = new globalThis.Map<string, KeyedGeometryEntry[]>();
  for (const { g } of visibleGeometries) {
    const existing = bySchema.get(g.schemaId);
    if (existing) {
      existing.push(g);
    } else {
      bySchema.set(g.schemaId, [g]);
    }
  }
  return bySchema;
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
 * Derived-dataset layers (roadmap 3a, #96) render ROW-PATH ONLY, from their
 * spec chain's bottom source dataset: geometry has no derived form until
 * stage 4's `geometrySource`, so each `derivedLayers` entry re-keys its
 * source's geometry rows under the derived id — the source's rows draw once
 * per derived layer that shows them (and once more if the source itself is
 * also a layer), each with its own color and visibility toggle. A feature
 * from a derived layer clicks through to the SOURCE dataset's entry (the
 * popup stays un-enriched until 3b).
 *
 * Entry properties load on demand (issue #52): clicking a feature starts one
 * indexed single-entry read (`entries.get`), subscribed — and live — only
 * while the popup is open. The map's first paint no longer pays an
 * O(total mapped rows) entries fetch that existed just to power this panel.
 * When the clicked dataset has saved, healthy derived-dataset specs (issue
 * #97), the popup executor additionally streams the specs' lookup datasets
 * through the seam — still only while the popup is open — and folds the
 * engine's namespaced fields onto the panel; a dataset without specs pays
 * nothing beyond the single entry read it always paid.
 *
 * The viewport fits exactly once, when the component mounts (the parent
 * mounts it as soon as the first layer's rows complete or the first tile
 * source is ready): the bounds are captured from the layers' datasets' stored
 * `boundingBox` extents via a lazy initializer and never change afterwards.
 * Hiding or showing layers (or any of their datasets), adding or removing
 * layers, or late-resolving payloads never moves the camera again; a fresh
 * page load re-fits. Derived layers contribute no bounds — a registry row is
 * deliberately virtual (no `boundingBox`, no stored extent), so a map whose
 * ONLY layers are derived ones opens on the default world view rather than
 * deriving bounds from rows (row-derived bounds would understate the extent
 * mid-stream — the exact bug the stored extents exist to prevent).
 */
export function LayersMap({
  datasets,
  derivedLayers = NO_DERIVED_LAYERS,
  chainLayers = NO_CHAIN_LAYERS,
  geometries,
  titlesById,
  visibleSchemaIds,
  colorBySchema,
  tileSources,
  sourcesPending = false,
  onTileSourceIdle,
}: {
  datasets: DatasetSummary[];
  /** Derived layers on this map: render id → the bottom source dataset its geometry rides. */
  derivedLayers?: Array<{ derivedId: string; sourceSchemaId: string }>;
  /**
   * 7b chain layers (#103): a dataset layer whose target resolves through a
   * version chain — render id (the layer's own target id, never rewritten) →
   * the resolved frozen row its geometry actually rides. The target's live
   * rows draw nothing; the resolved rows draw under the render id with
   * `sourceSchemaId` landing click payloads on the published dataset.
   */
  chainLayers?: Array<{ renderId: string; sourceSchemaId: string }>;
  geometries: GeometryEntry[];
  /** Titles for ids that aren't component datasets (derived registry rows), for legends and popup headers. */
  titlesById?: globalThis.Map<string, string>;
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
    // Derived layers re-key their source's rows (see `keyedGeometryRows`):
    // the plain rows stay so a source that is ALSO a layer keeps drawing as
    // itself; each showing derived layer gets its own copy of the row under
    // its id (shared objects re-wrapped, not re-fetched).
    keyedGeometries = keyedGeometryRows(
      geometries,
      derivedIdsBySourceOf(derivedLayers),
      chainSourceByRenderIdOf(chainLayers),
    ),
    // Most rows resolve synchronously (inline `geometryJson`); a row backed
    // by external storage is simply absent until its `fetch` completes.
    visibleGeometries = keyedGeometries.flatMap((g) => {
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
    // point-read path (issue #52) and enriched by the popup executor
    // (issue #97): one indexed single-doc subscription per selection plus —
    // only when the dataset has saved, healthy transform specs — the spec
    // and lookup-row reads that join the namespaced fields in. All of it
    // lives only while the popup is open; closing drops every subscription.
    popup = useEnrichedDatasetEntryRow(selected === null ? undefined : selected),
    selectedDatasetTitle = selected
      ? getDatasetTitle(datasetById, titlesById, selected.schemaId, "")
      : "";

  const bySchema = geometryRowsBySchema(visibleGeometries);
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
        title: getDatasetTitle(datasetById, titlesById, schemaId, "Untitled dataset"),
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
      {/* The popup executor's lookup-row fan-out (issue #97): renders
          nothing itself, holds the seam's live row subscriptions. */}
      {popup.loaders}
      {selected && (
        <FeatureDetailsPanel
          entry={popup.entry}
          entryId={selected.entryId}
          schemaId={selected.schemaId}
          datasetTitle={selectedDatasetTitle}
          joinedPending={popup.joinedPending}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

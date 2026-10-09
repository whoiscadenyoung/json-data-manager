import { buildFeatureCollection, unionBbox, useResolvedGeometries } from "@caden/json-cms/react";
import type { BoundingBox, Geometry } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Loader2, X } from "lucide-react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { Fragment, useState, type Ref } from "react";

import { Button } from "#/components/ui/button";
import { Map, MapClusterLayer, MapGeoJSON, MapVectorTiles } from "#/components/ui/map";
import type { DatasetEntryRow, DatasetGeometryRow } from "#/lib/dataset-rows";
import { useEnrichedDatasetEntryRow } from "#/lib/dataset-rows-react";
import { formatPropertyValue } from "#/lib/format";
import {
  asBoundingBox,
  buildPointFeatureCollection,
  splitPointLikeGeometries,
} from "#/lib/point-geometry";
import type { RenderLayer } from "#/lib/projects/map-layers";
import { paintsForStyle, toFeatureRow } from "#/lib/projects/map-layers";

/** A geometry row re-keyed to its render layer (`sourceSchemaId` is the entry's real home dataset). */
type KeyedGeometryEntry = DatasetGeometryRow & { sourceSchemaId?: string };

type FeatureProperties = { entryId: string; schemaId: string };

/** One render layer's tile source: its dataset's fresh PMTiles archive, drawn in the layer's own style. */
export type TileRenderLayer = { renderId: string; schemaId: string; url: string };

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
              // Base properties first; the popup executor's joined fields
              // arrive folded in as `<namespace>.<field>` keys (issue #97) —
              // an unmatched key renders as null ("—"), never an error.
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

type EntryDoc = DatasetEntryRow;

/** One legend swatch per render layer that actually has something on the map right now. */
function MapLegend({ layers }: { layers: RenderLayer[] }) {
  if (layers.length < 2) {
    return null;
  }
  return (
    <div className="bg-card/90 absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-x-3 gap-y-1 rounded-lg border border-border p-2 shadow-sm backdrop-blur-sm">
      {layers.map((layer) => (
        <div
          key={layer.renderId}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: layer.style.color }}
          />
          <span className="max-w-40 truncate">{layer.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Falls back to `fallback` when the dataset lookup misses — no optional-chained `?.title`. */
function datasetTitleOf(
  datasetById: globalThis.Map<string, { title: string }>,
  datasetId: string,
  fallback: string,
): string {
  const dataset = datasetById.get(datasetId);
  return dataset === undefined ? fallback : dataset.title;
}

/** Groups the visible, resolved rows by their RENDER id (the re-keyed row's schemaId) — the per-layer draw pass. */
function geometryRowsByRenderId(
  visibleGeometries: Array<{ g: KeyedGeometryEntry; resolved: Geometry }>,
): globalThis.Map<string, KeyedGeometryEntry[]> {
  const byRenderId = new globalThis.Map<string, KeyedGeometryEntry[]>();
  for (const { g } of visibleGeometries) {
    const existing = byRenderId.get(g.schemaId);
    if (existing === undefined) {
      byRenderId.set(g.schemaId, [g]);
    } else {
      existing.push(g);
    }
  }
  return byRenderId;
}

/** The stable empty list behind the canvas's `tileRenderLayers` default (the default-prop rule). */
const NO_TILE_RENDER_LAYERS: TileRenderLayer[] = [];

/**
 * The project map's canvas (phase 4): one draw pass per RENDER layer — an
 * owned data layer, a linked layer's frozen definition, or a group child —
 * each drawn in its OWN stored style (`layers.style`, edited by the style
 * panel). Two layers styling the same dataset draw it twice, each in its own
 * color; that per-layer styling is the point of the model, so — unlike the
 * standalone maps' canvas — nothing here keys on the dataset id except the
 * popup's dataset link. The page re-keys geometry rows per render layer
 * (`keyedGeometryRows`) before they arrive here.
 *
 * Tile-path layers arrive as `tileRenderLayers` (the dataset's fresh PMTiles
 * archive — one instance per render layer on the tile path; MapLibre shares
 * the archive's HTTP cache across the duplicate sources). Hidden tile layers
 * stay mounted with `visible: false`, keeping their source + tile cache warm.
 * Tile features carry `{entryId}`-only properties, so both paths click
 * through the same `{entryId, schemaId}` pair, with `schemaId` resolved to
 * the entry's real home dataset via `datasetIdByRenderId`.
 *
 * Every paint a layer draws comes from `paintsForStyle(layer.style)` — the
 * one style→paint mapping, so opacity (a group's transparency scaling) is
 * visible on fills, strokes, AND points (clusters are aggregation UI and
 * keep their own look). Entry properties load on demand (issue #52) and
 * enrich through the popup executor (issue #97) — subscriptions live only
 * while the popup is open.
 *
 * The viewport fits exactly once at mount from the layers' datasets' stored
 * `boundingBox` extents — UNLESS the map carries a saved camera
 * (`savedViewport`, `projectMaps.viewport`), which wins and applies through
 * controlled mode. Panning never saves anything; the editor's "Save view" is
 * the explicit write, reading the camera off `mapRef`.
 */
export function ProjectMapCanvas({
  datasets,
  datasetIdByRenderId,
  keyedGeometries,
  mapRef,
  renderLayers,
  savedViewport,
  sourcesPending = false,
  tileRenderLayers = NO_TILE_RENDER_LAYERS,
  visibleRenderIds,
  onTileSourceIdle,
}: {
  /** The render layers' datasets — titles, and the stored extents the one-shot fit reads. */
  datasets: Array<{ _id: string; boundingBox?: number[]; title: string }>;
  datasetIdByRenderId: globalThis.Map<string, string>;
  /** Every render layer's rows, re-keyed to render ids (visible or not — toggling on is an instant filter). */
  keyedGeometries: KeyedGeometryEntry[];
  /** Receives the MapLibre instance for the editor's "Save view" capture. */
  mapRef?: Ref<MapLibreMap>;
  renderLayers: RenderLayer[];
  /** The map's saved camera ({center, zoom, bearing, pitch}) — present wins over the extent fit. */
  savedViewport?: { bearing?: number; center?: [number, number]; pitch?: number; zoom?: number };
  /** True while any layer's tile-source decision is still resolving (suppresses the "nothing to draw" overlay). */
  sourcesPending?: boolean;
  tileRenderLayers?: TileRenderLayer[];
  visibleRenderIds: Set<string>;
  /** Fired once per tile source, after it loaded and the map reached `idle`. */
  onTileSourceIdle?: (schemaId: string) => void;
}) {
  const datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    resolvedGeometries = useResolvedGeometries(keyedGeometries),
    visibleGeometries = keyedGeometries.flatMap((g) => {
      if (!visibleRenderIds.has(g.schemaId)) {
        return [];
      }
      const resolved = resolvedGeometries.get(g._id);
      return resolved === undefined ? [] : [{ g, resolved }];
    }),
    // Captured exactly once, at mount, from the datasets' server-maintained
    // `schemas.boundingBox` — the same stored-extent rule the dataset maps
    // follow (row-derived bounds would understate the extent mid-stream).
    [initialBounds] = useState(() => {
      let bbox: BoundingBox | undefined;
      for (const dataset of datasets) {
        bbox = unionBbox(bbox, asBoundingBox(dataset.boundingBox));
      }
      return bbox;
    }),
    [selected, setSelected] = useState<FeatureProperties | null>(null),
    popup = useEnrichedDatasetEntryRow(selected === null ? undefined : selected),
    byRenderId = geometryRowsByRenderId(visibleGeometries),
    tileByRenderId = new globalThis.Map(tileRenderLayers.map((tile) => [tile.renderId, tile])),
    legendLayers = renderLayers.filter(
      (layer) => byRenderId.has(layer.renderId) || tileByRenderId.has(layer.renderId),
    ),
    visibleTileCount = tileRenderLayers.filter((tile) =>
      visibleRenderIds.has(tile.renderId),
    ).length,
    handleFeatureSelect = (properties: FeatureProperties) => {
      setSelected(properties);
    };

  return (
    <div className="relative h-full w-full">
      <Map
        ref={mapRef}
        bounds={savedViewport === undefined ? initialBounds : undefined}
        viewport={savedViewport}
        className="h-full w-full"
      >
        {renderLayers.map((layer) => {
          const tile = tileByRenderId.get(layer.renderId);
          if (tile !== undefined) {
            const paints = paintsForStyle(layer.style);
            return (
              <MapVectorTiles<{ entryId: string }>
                key={layer.renderId}
                id={`placement-${layer.renderId}`}
                url={tile.url}
                visible={layer.visible}
                interactive
                fillPaint={paints.fillPaint}
                linePaint={paints.linePaint}
                circlePaint={paints.circlePaint}
                fillHoverPaint={{ "fill-opacity": Math.min(1, layer.style.fillOpacity + 0.15) }}
                onIdle={() => {
                  if (onTileSourceIdle !== undefined) {
                    onTileSourceIdle(tile.schemaId);
                  }
                }}
                onClick={(e) => {
                  // Tiles carry id-only properties — the entry id is the
                  // join key; the dataset is this render layer's.
                  const datasetId = datasetIdByRenderId.get(layer.renderId);
                  if (datasetId !== undefined) {
                    setSelected({ entryId: e.feature.properties.entryId, schemaId: datasetId });
                  }
                }}
              />
            );
          }
          const rows = byRenderId.get(layer.renderId) ?? [];
          if (rows.length === 0) {
            return null;
          }
          // `MapGeoJSON` renders `fill`/`line` layers, which draw nothing for
          // Point/MultiPoint geometries — those go to `MapClusterLayer`.
          const { pointRows, otherRows } = splitPointLikeGeometries(rows),
            paints = paintsForStyle(layer.style),
            withResolved = (items: KeyedGeometryEntry[]) =>
              items.flatMap((g) => {
                const resolved = resolvedGeometries.get(g._id);
                return resolved === undefined ? [] : [toFeatureRow(g, resolved)];
              }),
            otherCollection = buildFeatureCollection<FeatureProperties>(withResolved(otherRows)),
            pointCollection = buildPointFeatureCollection<FeatureProperties>(
              withResolved(pointRows),
            );
          return (
            <Fragment key={layer.renderId}>
              {otherCollection.features.length > 0 && (
                <MapGeoJSON<FeatureProperties>
                  data={otherCollection}
                  interactive
                  fillPaint={paints.fillPaint}
                  linePaint={paints.linePaint}
                  fillHoverPaint={{ "fill-opacity": Math.min(1, layer.style.fillOpacity + 0.15) }}
                  onClick={(e) => {
                    handleFeatureSelect(e.feature.properties);
                  }}
                />
              )}
              {pointCollection.features.length > 0 && (
                <MapClusterLayer<FeatureProperties>
                  data={pointCollection}
                  pointColor={layer.style.color}
                  pointOpacity={layer.style.opacity}
                  pointRadius={layer.style.radius}
                  onPointClick={(feature) => {
                    handleFeatureSelect(feature.properties);
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </Map>
      {visibleGeometries.length === 0 && visibleTileCount === 0 && !sourcesPending && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/40 p-6 text-center backdrop-blur-[1px]">
          <p className="text-sm text-muted-foreground">
            Nothing to draw — every visible layer is empty or its datasets have no features.
          </p>
        </div>
      )}
      <MapLegend layers={legendLayers} />
      {/* The popup executor's lookup-row fan-out (issue #97): renders
          nothing itself, holds the seam's live row subscriptions. */}
      {popup.loaders}
      {selected && (
        <FeatureDetailsPanel
          entry={popup.entry}
          entryId={selected.entryId}
          schemaId={selected.schemaId}
          datasetTitle={datasetTitleOf(datasetById, selected.schemaId, "Dataset")}
          joinedPending={popup.joinedPending}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

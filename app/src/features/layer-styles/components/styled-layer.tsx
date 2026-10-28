import { useMap } from "@caden/ui/components/map";
import type * as MapLibreGL from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";

import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { entryDataRecord } from "#/lib/dataset-rows";
import type { StyleLayer } from "#convex/layerStyles/validators";

import { ensureMapImages, type UploadedIcon } from "../lib/icon-images";
import { iconNamesOfLayer, iconNamesOfLayers } from "../lib/icons";

/** The MVT source layer our tile writer emits (`MapVectorTiles`' default). */
const TILE_SOURCE_LAYER = "geojson";

type FeatureValues = ReadonlyMap<string, Record<string, unknown>>;

/** Joins a style's field names into `fieldsKey` (a stable memo key; no field name contains it). */
export const FIELD_SEPARATOR = "\u0000";

/** The style's fields of each loaded entry, keyed by entry id. */
function valuesByEntry(rows: readonly DatasetEntryRow[], fieldsKey: string): FeatureValues {
  const fields = fieldsKey === "" ? [] : fieldsKey.split(FIELD_SEPARATOR),
    byEntry = new Map<string, Record<string, unknown>>();
  if (fields.length === 0) {
    return byEntry;
  }
  for (const row of rows) {
    const data = entryDataRecord(row),
      picked: Record<string, unknown> = {};
    for (const field of fields) {
      if (Object.hasOwn(data, field)) {
        picked[field] = data[field];
      }
    }
    byEntry.set(row._id, picked);
  }
  return byEntry;
}

export type StyledLayerSource =
  | {
      kind: "rows";
      data: GeoJSON.FeatureCollection<GeoJSON.Geometry, { entryId: string; schemaId: string }>;
    }
  | { kind: "tiles"; url: string };

/** Row-path features with the style's field values merged into their properties (`["get", field]` reads them). */
function withValues(
  data: Extract<StyledLayerSource, { kind: "rows" }>["data"],
  values: FeatureValues,
): GeoJSON.FeatureCollection {
  if (values.size === 0) {
    return data;
  }
  return {
    features: data.features.map((feature) => {
      const extra = values.get(feature.properties.entryId);
      return extra === undefined
        ? feature
        : { ...feature, properties: { ...extra, ...feature.properties } };
    }),
    type: "FeatureCollection",
  };
}

function sourceSpec(
  source: StyledLayerSource,
  rowData: GeoJSON.FeatureCollection | undefined,
): MapLibreGL.SourceSpecification {
  if (source.kind === "tiles") {
    // Tiles carry `entryId` on every feature; promoting it keys feature-state.
    return { promoteId: "entryId", type: "vector", url: source.url };
  }
  return {
    data: rowData === undefined ? { features: [], type: "FeatureCollection" } : rowData,
    promoteId: "entryId",
    type: "geojson",
  };
}

function removeLayers(map: MapLibreGL.Map, layerIds: readonly string[]) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  }
}

/** One stored fragment as a full MapLibre layer on this source. */
function layerSpec(
  fragment: StyleLayer,
  layerId: string,
  sourceId: string,
  source: StyledLayerSource,
  visible: boolean,
): MapLibreGL.LayerSpecification {
  const visibility = visible ? "visible" : "none";
  // Stored fragments are MapLibre style-spec JSON (validated in the editor);
  // MapLibre re-validates at addLayer and rejects a bad layer on its own.
  return {
    ...fragment,
    id: layerId,
    layout: { ...fragment.layout, visibility },
    source: sourceId,
    ...(source.kind === "tiles" ? { "source-layer": TILE_SOURCE_LAYER } : {}),
  };
}

/**
 * Draws one dataset with a stored MapLibre style (docs/layer-styles.md):
 * its own source — the row-path features (style field values merged into
 * properties) or the tile archive — and one MapLibre layer per style
 * fragment. On the tile path the caller passes paint-only fragments already
 * rewritten onto feature-state, and this component writes the field values
 * as feature-state keyed by `entryId`.
 *
 * A fragment MapLibre rejects is skipped (logged by MapLibre) so one bad
 * hand-written layer never blanks the rest of the map.
 */
export function StyledLayer({
  renderId,
  layers,
  source,
  entryRows,
  fieldsKey,
  visible,
  uploads,
  uploadsReady,
  onSelect,
  onTileIdle,
}: {
  renderId: string;
  layers: readonly StyleLayer[];
  source: StyledLayerSource;
  /** The entries holding the style's field values (stable per loaded page set). */
  entryRows: readonly DatasetEntryRow[];
  /** The fields the style reads, joined by `FIELD_SEPARATOR` ("" = none). */
  fieldsKey: string;
  visible: boolean;
  /** Uploaded icons by `icon-image` name (for `user-*` markers). */
  uploads: ReadonlyMap<string, UploadedIcon>;
  /** Whether `uploads` has loaded — icon layers wait for it so uploads never draw blank. */
  uploadsReady: boolean;
  onSelect: (selection: { entryId: string; schemaId?: string }) => void;
  onTileIdle: () => void;
}) {
  const { map, isLoaded } = useMap(),
    sourceId = `styled-source-${renderId}`,
    sourceKey = source.kind === "tiles" ? source.url : "rows",
    // Merged into row features, or written as tile feature-state.
    values = useMemo(() => valuesByEntry(entryRows, fieldsKey), [entryRows, fieldsKey]),
    rowData = useMemo(
      () => (source.kind === "rows" ? withValues(source.data, values) : undefined),
      [source, values],
    ),
    layerIds = useMemo(
      () => layers.map((_, index) => `styled-${renderId}-${index}`),
      [layers, renderId],
    ),
    latestRef = useRef({ onSelect, onTileIdle, rowData, source, uploads });
  latestRef.current = { onSelect, onTileIdle, rowData, source, uploads };

  // The source: (re)added when the map (re)loads its style or the archive URL changes.
  useEffect(() => {
    if (!isLoaded || !map) {
      return undefined;
    }
    const { source: current, rowData: data } = latestRef.current;
    map.addSource(sourceId, sourceSpec(current, data));
    const idleHandler = () => {
      latestRef.current.onTileIdle();
    };
    if (current.kind === "tiles") {
      map.once("idle", idleHandler);
    }
    return () => {
      map.off("idle", idleHandler);
      try {
        const style = map.getStyle();
        removeLayers(
          map,
          style.layers
            .filter((layer) => layer.id.startsWith(`styled-${renderId}-`))
            .map((layer) => layer.id),
        );
        if (map.getSource(sourceId)) {
          map.removeSource(sourceId);
        }
      } catch {
        // The style may be mid-reload (theme switch); it drops our layers itself.
      }
    };
  }, [isLoaded, map, sourceId, sourceKey, renderId]);

  // Row data: push merged features when rows or values change.
  useEffect(() => {
    if (!isLoaded || !map || rowData === undefined) {
      return;
    }
    const geojson = map.getSource(sourceId);
    if (geojson !== undefined && geojson.type === "geojson") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by `type === "geojson"` just above.
      void (geojson as MapLibreGL.GeoJSONSource).setData(rowData);
    }
  }, [isLoaded, map, sourceId, rowData]);

  // Tile values: feature-state keyed by the promoted entry id.
  useEffect(() => {
    if (!isLoaded || !map || source.kind !== "tiles" || !map.getSource(sourceId)) {
      return;
    }
    for (const [entryId, entryValues] of values) {
      map.setFeatureState(
        { id: entryId, source: sourceId, sourceLayer: TILE_SOURCE_LAYER },
        entryValues,
      );
    }
  }, [isLoaded, map, source.kind, sourceId, values, sourceKey]);

  // Layers: rebuilt whenever the style changes (a style is a handful of
  // layers). Icon layers first register their sprite images (async, once per
  // map style), so a marker never draws before its image exists.
  useEffect(() => {
    if (!isLoaded || !map || !map.getSource(sourceId)) {
      return undefined;
    }
    let cancelled = false;
    const iconNames = iconNamesOfLayers(layers),
      addLayers = () => {
        if (cancelled || !map.getSource(sourceId)) {
          return;
        }
        for (const [index, fragment] of layers.entries()) {
          try {
            map.addLayer(layerSpec(fragment, layerIds[index], sourceId, source, visible));
          } catch {
            // MapLibre rejected this fragment; draw the rest.
          }
        }
      };
    if (iconNames.length === 0) {
      addLayers();
    } else if (uploadsReady) {
      void ensureMapImages(map, iconNames, latestRef.current.uploads).then(addLayers);
    }
    return () => {
      cancelled = true;
      try {
        removeLayers(map, layerIds);
      } catch {
        // Style mid-reload.
      }
    };
    // `visible` is synced by the effect below without a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, map, sourceId, sourceKey, layers, layerIds, uploadsReady]);

  useEffect(() => {
    if (!isLoaded || !map) {
      return;
    }
    for (const layerId of layerIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    }
  }, [isLoaded, map, layerIds, visible]);

  // Clicks open the feature popup (markers are click targets; text labels aren't).
  useEffect(() => {
    if (!isLoaded || !map) {
      return undefined;
    }
    const targets = layerIds.filter(
        (_, index) => layers[index].type !== "symbol" || iconNamesOfLayer(layers[index]).length > 0,
      ),
      handleClick = (event: MapLibreGL.MapLayerMouseEvent) => {
        const feature = event.features === undefined ? undefined : event.features[0];
        if (feature === undefined) {
          return;
        }
        const properties = feature.properties,
          entryId = typeof properties["entryId"] === "string" ? properties["entryId"] : feature.id,
          schemaId =
            typeof properties["schemaId"] === "string" ? properties["schemaId"] : undefined;
        if (typeof entryId === "string") {
          latestRef.current.onSelect({ entryId, schemaId });
        }
      },
      handleEnter = () => {
        map.getCanvas().style.cursor = "pointer";
      },
      handleLeave = () => {
        map.getCanvas().style.cursor = "";
      };
    for (const layerId of targets) {
      map.on("click", layerId, handleClick);
      map.on("mouseenter", layerId, handleEnter);
      map.on("mouseleave", layerId, handleLeave);
    }
    return () => {
      for (const layerId of targets) {
        map.off("click", layerId, handleClick);
        map.off("mouseenter", layerId, handleEnter);
        map.off("mouseleave", layerId, handleLeave);
      }
    };
  }, [isLoaded, map, layerIds, layers]);

  return null;
}

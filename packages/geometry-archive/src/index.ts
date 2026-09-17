/**
 * `@caden/geometry-archive` — builds a PMTiles v3 vector-tile archive
 * (gzip-compressed MVT) from GeoJSON features in pure JavaScript, safe for
 * browsers, web workers, and Node.
 */
import { assembleArchive } from "./assemble";
import { SOURCE_LAYER_NAME, collectionBounds, tileFeatures } from "./tiles";
import {
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  MAX_ZOOM,
  type BuildGeometryArchiveOptions,
} from "./types";

export { SOURCE_LAYER_NAME, MVT_EXTENT, TILE_BUFFER_UNITS } from "./tiles";
export { DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM, MAX_ZOOM } from "./types";
export type {
  ArchiveTile,
  BuildGeometryArchiveOptions,
  GeoJSONFeature,
  GeoJSONGeometry,
} from "./types";

/** Field type names used in the archive's TileJSON `vector_layers` metadata. */
type FieldType = "String" | "Number" | "Boolean";

/** Maps JS typeof names onto MVT `vector_layers` field type names. */
const FIELD_TYPES: Partial<Record<string, FieldType>> = {
  string: "String",
  number: "Number",
  boolean: "Boolean",
};

/**
 * Observes one field type per projected property key. `entryId` is always
 * declared since it is the id-only projection's join key.
 */
function observedFields(
  features: BuildGeometryArchiveOptions["features"],
  includeProperties: readonly string[],
): Record<string, FieldType> {
  const fields: Record<string, FieldType> = { entryId: "String" };
  for (const feature of features) {
    if (feature === null || feature === undefined) {
      continue;
    }
    observeFeatureFields(feature.properties, includeProperties, fields);
  }
  return fields;
}

/** Records the observed type of each allow-listed key on one feature. */
function observeFeatureFields(
  raw: Record<string, unknown> | null,
  includeProperties: readonly string[],
  fields: Record<string, FieldType>,
): void {
  if (raw === null || raw === undefined) {
    return;
  }
  for (const key of includeProperties) {
    if (fields[key] !== undefined) {
      continue;
    }
    const observed = FIELD_TYPES[typeof raw[key]];
    if (observed !== undefined) {
      fields[key] = observed;
    }
  }
}

/** Validates the archive zoom range, throwing on out-of-range values. */
function validateZoomRange(minZoom: number, maxZoom: number): void {
  if (!Number.isInteger(minZoom) || minZoom < 0 || minZoom > MAX_ZOOM) {
    throw new RangeError(`minZoom must be an integer in [0, ${MAX_ZOOM}]`);
  }
  if (!Number.isInteger(maxZoom) || maxZoom < minZoom || maxZoom > MAX_ZOOM) {
    throw new RangeError(`maxZoom must be an integer in [${minZoom}, ${MAX_ZOOM}]`);
  }
}

/** Builds the v3 JSON metadata section for a vector-tile archive. */
function buildMetadata(
  features: BuildGeometryArchiveOptions["features"],
  includeProperties: readonly string[],
  minZoom: number,
  maxZoom: number,
): string {
  return JSON.stringify({
    vector_layers: [
      {
        id: SOURCE_LAYER_NAME,
        fields: observedFields(features, includeProperties),
        minzoom: minZoom,
        maxzoom: maxZoom,
      },
    ],
    compression: "gzip",
    tile_type: "MVT",
    minzoom: minZoom,
    maxzoom: maxZoom,
  });
}

/**
 * Builds a complete PMTiles v3 archive as one `Uint8Array` from
 * full-resolution GeoJSON features.
 *
 * Throws when the inputs produce no tiles (nothing to archive) or when the
 * zoom range is invalid.
 */
export async function buildGeometryArchive(
  options: BuildGeometryArchiveOptions,
): Promise<Uint8Array> {
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
  validateZoomRange(minZoom, maxZoom);
  if (!Array.isArray(options.features)) {
    throw new TypeError("features must be an array of GeoJSON features");
  }

  const includeProperties = options.includeProperties ?? [];
  const tiles = tileFeatures(options.features, minZoom, maxZoom, includeProperties);
  if (tiles.length === 0) {
    throw new Error("no vector tiles were produced; nothing to archive");
  }

  const bounds = collectionBounds(options.features);
  if (bounds === undefined) {
    throw new Error("no vector tiles were produced; nothing to archive");
  }

  return assembleArchive({
    tiles,
    metadata: buildMetadata(options.features, includeProperties, minZoom, maxZoom),
    minZoom,
    maxZoom,
    minLon: bounds.minLon,
    minLat: bounds.minLat,
    maxLon: bounds.maxLon,
    maxLat: bounds.maxLat,
    centerZoom: Math.min(maxZoom, Math.max(minZoom, Math.round((minZoom + maxZoom) / 2))),
  });
}

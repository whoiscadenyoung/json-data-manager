/**
 * Detects and flattens GeoJSON (a `FeatureCollection` document, or a bare
 * array of `Feature` objects) into plain data + geometry rows.
 *
 * This is deliberately NOT folded into `parse-data.ts`'s `parseDataRows` —
 * that function already collapses a single top-level JSON object into a
 * one-row dataset, which would silently mangle a `FeatureCollection` object
 * (also top-level, also an object). Detection has to happen on the raw
 * parsed JSON *before* `parseDataRows` runs, and take a completely separate
 * path when it matches.
 *
 * Deliberately out of scope for v1: NDJSON "one Feature per line" files.
 * Only a single `FeatureCollection` document or a bare `Feature` array are
 * supported.
 */
import { coalesceGeometryTypes } from "../../shared/geojson/coalesce.js";
import { assertGeometry } from "../../shared/geojson/geometry.js";
import type { Geometry, GeometryType } from "../../shared/geojson/types.js";

export interface GeoJsonRow {
  /** The Feature's `properties` (or `{}` if absent/null). */
  data: Record<string, unknown>;
  /** `undefined` for a Feature whose `geometry` is `null` (a valid, geometry-less GeoJSON row). */
  geometry: Geometry | undefined;
}

export interface GeoJsonFeatureError {
  index: number;
  message: string;
}

export interface GeoJsonParseResult {
  rows: GeoJsonRow[];
  /** The coalesced dataset-level geometry type, or `null` if every row is geometry-less (nothing to coalesce), or `null` with `errors` populated if geometries conflict. */
  geometryType: GeometryType | null;
  /** Set only when geometry types conflict in a way that can't coalesce (see coalesceGeometryTypes) — a dataset-level error, distinct from per-row `errors`. */
  coalesceError: string | undefined;
  errors: GeoJsonFeatureError[];
  /**
   * Count of successfully-parsed rows per pre-coalesce geometry type
   * (geometry-less rows aren't counted here). Lets a caller show e.g.
   * "142 Polygon + 8 MultiPolygon" before it was coalesced to one type.
   */
  typeCounts: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFeatureShaped(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "Feature";
}

/** True for a GeoJSON FeatureCollection object, or a bare JSON array of Feature-shaped objects. Never throws. */
export function looksLikeGeoJson(value: unknown): boolean {
  if (isRecord(value) && value.type === "FeatureCollection" && Array.isArray(value.features)) {
    return true;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value.every((item) => isFeatureShaped(item));
  }
  return false;
}

/** Extracts the raw features array from a FeatureCollection or a bare Feature array. */
function extractFeatures(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.features)) {
    return value.features;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function extractProperties(feature: Record<string, unknown>): Record<string, unknown> {
  const { properties } = feature;
  return isRecord(properties) ? properties : {};
}

/** Parses one raw feature into a row, or an error keyed by its index. Never throws. */
function parseOneFeature(
  feature: unknown,
  index: number,
): { row?: GeoJsonRow; error?: GeoJsonFeatureError } {
  if (!isFeatureShaped(feature)) {
    return { error: { index, message: `Feature ${index}: expected a GeoJSON Feature object.` } };
  }
  const data = extractProperties(feature),
    rawGeometry = feature.geometry;
  if (rawGeometry === null || rawGeometry === undefined) {
    return { row: { data, geometry: undefined } };
  }
  try {
    return { row: { data, geometry: assertGeometry(rawGeometry) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid geometry.";
    return { error: { index, message: `Feature ${index}: ${message}` } };
  }
}

function parseAllFeatures(features: unknown[]): {
  rows: GeoJsonRow[];
  errors: GeoJsonFeatureError[];
} {
  const rows: GeoJsonRow[] = [],
    errors: GeoJsonFeatureError[] = [];
  for (const [index, feature] of features.entries()) {
    const { row, error } = parseOneFeature(feature, index);
    if (row !== undefined) {
      rows.push(row);
    }
    if (error !== undefined) {
      errors.push(error);
    }
  }
  return { errors, rows };
}

/** Tallies each row's geometry type (geometry-less rows excluded), for coalescing and for the caller's summary display. */
function tallyGeometryTypes(rows: GeoJsonRow[]): {
  types: GeometryType[];
  typeCounts: Record<string, number>;
} {
  const types: GeometryType[] = [],
    typeCounts: Record<string, number> = {};
  for (const row of rows) {
    if (row.geometry !== undefined) {
      const { type } = row.geometry;
      types.push(type);
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }
  }
  return { typeCounts, types };
}

/**
 * Flatten a parsed FeatureCollection (or bare Feature array) into rows,
 * validating + coalescing geometry along the way. Never throws — per-feature
 * problems are collected in `errors` by index and that row is skipped
 * entirely (not included in `rows`); a dataset-level coalescing conflict is
 * reported via `coalesceError` with `rows` still populated for the
 * successfully-parsed geometries/properties (caller decides whether a
 * coalesce conflict should block the whole import — it should, but that's a
 * caller decision, not this function's).
 */
export function parseGeoJsonFeatures(value: unknown): GeoJsonParseResult {
  const { rows, errors } = parseAllFeatures(extractFeatures(value)),
    { types, typeCounts } = tallyGeometryTypes(rows);

  if (types.length === 0) {
    return { coalesceError: undefined, errors, geometryType: null, rows, typeCounts };
  }

  const outcome = coalesceGeometryTypes(types);
  if (outcome.ok) {
    return {
      coalesceError: undefined,
      errors,
      geometryType: outcome.geometryType,
      rows,
      typeCounts,
    };
  }
  return { coalesceError: outcome.error, errors, geometryType: null, rows, typeCounts };
}

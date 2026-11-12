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
import { coalesceGeometryTypes } from "@caden/data-core/geojson";
import { assertGeometry } from "@caden/data-core/geojson";
import type { Geometry, GeometryType } from "@caden/data-core/geojson";

export interface GeoJsonRow {
  /** The Feature's `properties` (or `{}` if absent/null). */
  data: Record<string, unknown>;
  /** `undefined` for a Feature whose `geometry` is `null` (a valid, geometry-less GeoJSON row). */
  geometry: Geometry | undefined;
  /**
   * The Feature's parent-level fields — everything outside
   * `type`/`geometry`/`properties` (the spec's `id`, plus whatever else the
   * file carries there, which RFC 7946 permits). Nothing here enters `data`
   * unless the caller explicitly preserves it (see `mergeFeatureFields`), so
   * imports stay byte-faithful to the properties by default.
   */
  featureFields: Record<string, unknown>;
}

/** One parent-level field candidate across the parsed features. */
export interface GeoJsonFeatureField {
  key: string;
  /** How many parsed features carry it (a field absent from every feature can't exist here). */
  count: number;
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
   * The parent-level fields (outside `type`/`geometry`/`properties`) found
   * across the parsed features, with per-field presence counts — the
   * preservation picker's candidates. Sorted by presence then key. Empty for
   * bare arrays or files whose features carry only the standard members.
   */
  featureFields: GeoJsonFeatureField[];
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

/** The Feature's non-standard parent-level members: everything except `type`, `geometry`, and `properties`. */
function extractFeatureFields(feature: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(feature)) {
    if (key !== "type" && key !== "geometry" && key !== "properties") {
      fields[key] = value;
    }
  }
  return fields;
}

/** Tallies the parent-level fields across rows into presence-counted candidates, most-present first. */
function summarizeFeatureFields(rows: GeoJsonRow[]): GeoJsonFeatureField[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.featureFields)) {
      if (value !== undefined) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ count, key }))
    .toSorted((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Folds the selected parent-level fields into a row's `data` (the merge is
 * applied over the ORIGINAL properties each time, so toggling a field on and
 * off returns to the exact pre-merge shape). A preserved field wins over a
 * same-named property — the caller opted in deliberately, and the picker
 * flags collisions so overwrites are never silent.
 */
export function mergeFeatureFields(
  row: GeoJsonRow,
  selected: readonly string[],
): Record<string, unknown> {
  if (selected.length === 0) {
    return { ...row.data };
  }
  const picked: Record<string, unknown> = {};
  for (const key of selected) {
    if (row.featureFields[key] !== undefined) {
      picked[key] = row.featureFields[key];
    }
  }
  return { ...row.data, ...picked };
}

/** Keys in `selected` that collide with a property name across these rows — the overwrite warning's data. */
export function collidingFeatureFields(
  rows: readonly GeoJsonRow[],
  selected: readonly string[],
): string[] {
  if (selected.length === 0) {
    return [];
  }
  const collisions = new Set<string>();
  for (const key of selected) {
    for (const row of rows) {
      if (row.featureFields[key] !== undefined && key in row.data) {
        collisions.add(key);
        break;
      }
    }
  }
  return [...collisions];
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
    featureFields = extractFeatureFields(feature),
    rawGeometry = feature.geometry;
  if (rawGeometry === null || rawGeometry === undefined) {
    return { row: { data, featureFields, geometry: undefined } };
  }
  try {
    return { row: { data, featureFields, geometry: assertGeometry(rawGeometry) } };
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
    return {
      coalesceError: undefined,
      errors,
      featureFields: summarizeFeatureFields(rows),
      geometryType: null,
      rows,
      typeCounts,
    };
  }

  const outcome = coalesceGeometryTypes(types);
  if (outcome.ok) {
    return {
      coalesceError: undefined,
      errors,
      featureFields: summarizeFeatureFields(rows),
      geometryType: outcome.geometryType,
      rows,
      typeCounts,
    };
  }
  return {
    coalesceError: outcome.error,
    errors,
    featureFields: summarizeFeatureFields(rows),
    geometryType: null,
    rows,
    typeCounts,
  };
}

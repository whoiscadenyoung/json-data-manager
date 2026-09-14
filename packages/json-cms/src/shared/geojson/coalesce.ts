import type { GeometryType } from "./types.js";

export type CoalesceOutcome =
  | { ok: true; geometryType: GeometryType }
  | { ok: false; error: string };

function familyOf(type: GeometryType): GeometryType {
  if (type === "Polygon" || type === "MultiPolygon") return "MultiPolygon";
  if (type === "LineString" || type === "MultiLineString") return "MultiLineString";
  return type; // Point / MultiPoint never coalesce with each other
}

/**
 * Resolves the single geometryType a dataset should be locked to from a batch
 * of observed geometry types (entries with no geometry are pre-filtered out
 * by the caller before this is called).
 *
 * Rules: a single type alone stays itself. Polygon+MultiPolygon coalesce to
 * "MultiPolygon". LineString+MultiLineString coalesce to "MultiLineString".
 * Point+MultiPoint together is an error (they never coalesce). Any other mix
 * (e.g. Point+Polygon) is an error. An empty batch is an error.
 */
export function coalesceGeometryTypes(types: GeometryType[]): CoalesceOutcome {
  const distinct = [...new Set(types)];
  if (distinct.length === 0) {
    return { ok: false, error: "No geometries to coalesce." };
  }
  if (distinct.length === 1) {
    const [only] = distinct;
    return { ok: true, geometryType: only };
  }
  if (distinct.includes("Point") && distinct.includes("MultiPoint")) {
    return { ok: false, error: "A dataset cannot mix Point and MultiPoint geometries." };
  }
  const families = new Set(distinct.map(familyOf));
  if (families.size > 1) {
    return {
      ok: false,
      // oxlint-disable-next-line unicorn/no-array-sort -- `.toSorted()` needs ES2023 lib; this repo targets ES2021, and the copy here is never reused so mutating it is harmless.
      error: `Incompatible geometry types in the same dataset: ${[...distinct].sort().join(", ")}.`,
    };
  }
  const [family] = families;
  return { ok: true, geometryType: family };
}

/**
 * Whether a single geometry's literal type is acceptable for a dataset
 * already locked to `datasetType`. No auto-promotion: a dataset locked to
 * plain "Polygon" rejects a later "MultiPolygon" (asymmetric with the
 * reverse — a dataset locked to "MultiPolygon" DOES accept a "Polygon").
 */
export function isGeometryCompatibleWithDatasetType(
  entryType: GeometryType,
  datasetType: GeometryType,
): boolean {
  return entryType === datasetType || familyOf(entryType) === datasetType;
}

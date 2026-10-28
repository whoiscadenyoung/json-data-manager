/**
 * `@caden/data-core/geojson` — GeoJSON types, validation, bbox/rounding
 * helpers, feature builders, and the Convex geometry validators. Named
 * re-exports only (`oxc/no-barrel-file` rejects `export *`).
 */
export { coalesceGeometryTypes, isGeometryCompatibleWithDatasetType } from "./coalesce.js";
export type { CoalesceOutcome } from "./coalesce.js";
export { GeometryError, GeoParseError } from "./error.js";
export { buildFeature, buildFeatureCollection } from "./geojson.js";
export type { FeatureRow } from "./geojson.js";
export {
  assertGeometry,
  computeBbox,
  GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
  isValidGeometry,
  roundGeometryCoordinates,
  unionBbox,
} from "./geometry.js";
export type { BoundingBox } from "./geometry.js";
export { GEOMETRY_TYPES } from "./types.js";
export type {
  Feature,
  FeatureCollection,
  Geometry,
  GeometryType,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from "./types.js";
export {
  convexLineStringValidator,
  convexMultiLineStringValidator,
  convexMultiPointValidator,
  convexMultiPolygonValidator,
  convexPointValidator,
  convexPolygonValidator,
  geometryArgsValidator,
  geometryTypeValidator,
} from "./validators.js";
export type { GeometryArgs, GeometryTypeArg } from "./validators.js";

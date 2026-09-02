import type {
  Feature as GeoJsonFeature,
  FeatureCollection as GeoJsonFeatureCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";

export type { LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon };

/**
 * The six GeoJSON geometry type names this package supports, in one place so
 * `GeometryType` below and the Convex `geometryTypeValidator` in
 * `./validators.ts` are both derived from it instead of re-typing all six
 * names in two places.
 */
export const GEOMETRY_TYPES = [
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
] as const;

/**
 * The six GeoJSON geometry types this app supports. GeometryCollection is
 * deliberately excluded — separate datasets are used for different geometry
 * types instead of mixing them in one.
 */
export type Geometry = Point | MultiPoint | LineString | MultiLineString | Polygon | MultiPolygon;

export type GeometryType = (typeof GEOMETRY_TYPES)[number];

export type Feature<P = Record<string, unknown> | null> = GeoJsonFeature<Geometry, P>;
export type FeatureCollection<P = Record<string, unknown> | null> = GeoJsonFeatureCollection<
  Geometry,
  P
>;

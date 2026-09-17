/** Minimal RFC 7946 subset the archive builder consumes. */
export type GeoJSONGeometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "MultiPoint"; coordinates: number[][] }
  | { type: "LineString"; coordinates: number[][] }
  | { type: "MultiLineString"; coordinates: number[][][] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "GeometryCollection"; geometries: GeoJSONGeometry[] };

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry | null;
  properties: Record<string, unknown> | null;
  /**
   * Convex row id carried on the feature (app convention). When present it
   * becomes the tile feature's `entryId` property; `properties.entryId` and
   * `properties._id` are accepted as fallbacks.
   */
  _id?: string;
}

/** A finished, gzip-compressed MVT tile paired with its PMTiles Hilbert id. */
export interface ArchiveTile {
  tileId: number;
  data: Uint8Array;
}

export interface BuildGeometryArchiveOptions {
  /** Full-resolution GeoJSON features, typically one per dataset row. */
  features: GeoJSONFeature[];
  /** Lowest zoom written to the archive. Default 0. */
  minZoom?: number;
  /** Highest zoom written to the archive. Default 14 (GEOMETRY_ARCHIVE_MAX_ZOOM). */
  maxZoom?: number;
  /**
   * Allow-list of property keys carried into tiles. Default [] writes the
   * id-only projection (`entryId` only); `entryId` is always included.
   */
  includeProperties?: string[];
}

export const DEFAULT_MIN_ZOOM = 0;
export const DEFAULT_MAX_ZOOM = 14;
/** geojson-vt accepts up to zoom 24; PMTiles tile ids stay exact below zoom 27. */
export const MAX_ZOOM = 24;

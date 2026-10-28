/**
 * Turns dataset geometry rows into GeoJSON features for the archive builder
 * (issue #58 part 3, byte counting from #134): parse inline payloads, fetch
 * blob-stored ones, and count real UTF-8 bytes either way. Backend-free: the
 * app's build worker pages the rows and passes each one in.
 */
import type { GeoJSONFeature, GeoJSONGeometry } from "@caden/geometry-archive";

/** The fields of a dataset geometry row this module reads. */
export interface GeometryRowRef {
  entryId: string;
  /** Inline geometry JSON, when the payload is stored on the row. */
  geometryJson?: string;
  /** Storage URL of the geometry payload, when it lives in file storage. */
  geometryUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const GEOMETRY_TYPES_WITH_COORDINATES = new Set([
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
  "Point",
  "LineString",
  "Polygon",
]);

export function isGeometry(value: unknown): value is GeoJSONGeometry {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "GeometryCollection") return "geometries" in value;
  return GEOMETRY_TYPES_WITH_COORDINATES.has(value.type) && "coordinates" in value;
}

export function parseGeometry(json: string, source: string): GeoJSONGeometry {
  const value: unknown = JSON.parse(json);
  if (!isGeometry(value)) {
    throw new Error(`${source} did not parse to a GeoJSON geometry object.`);
  }
  return value;
}

export async function fetchGeometry(
  url: string,
): Promise<{ bytes: number; geometry: GeoJSONGeometry }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Geometry payload fetch failed with HTTP ${response.status}`);
  }
  // Count real bytes off the wire — `text.length` counts UTF-16 code units,
  // which undercounts multi-byte payloads (issue #134).
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  return { bytes: buffer.byteLength, geometry: parseGeometry(text, `Geometry payload ${url}`) };
}

/** UTF-8 byte length of an inline payload — `text.length` counts UTF-16 code
 * units, not bytes (issue #134). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function feature(entryId: string, geometry: GeoJSONGeometry): GeoJSONFeature {
  // `_id` is the archive lib's app convention: it becomes the tile feature's
  // `entryId` property — the join key part 4 maps a tile click back through.
  return { _id: entryId, geometry, properties: null, type: "Feature" };
}

export interface ResolvedGeometryRow {
  bytes: number;
  entryId: string;
  geometry: GeoJSONGeometry;
}

export async function resolveRow(row: GeometryRowRef): Promise<ResolvedGeometryRow | null> {
  if (row.geometryJson !== undefined) {
    return {
      bytes: utf8ByteLength(row.geometryJson),
      entryId: row.entryId,
      geometry: parseGeometry(row.geometryJson, `Geometry row ${row.entryId}`),
    };
  }
  if (row.geometryUrl === undefined) return null;
  const fetched = await fetchGeometry(row.geometryUrl);
  return { bytes: fetched.bytes, entryId: row.entryId, geometry: fetched.geometry };
}

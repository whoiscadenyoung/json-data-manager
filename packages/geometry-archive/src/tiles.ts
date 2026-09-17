/**
 * GeoJSON features → geojson-vt tile index → gzip-compressed MVT tiles,
 * sorted by ascending PMTiles Hilbert tile id.
 *
 * Property projection: tile features always carry `entryId` (resolved from
 * the feature's `_id`, falling back to `properties.entryId` then
 * `properties._id`); `includeProperties` extends it with allow-listed keys.
 */
import GeoJSONVT from "geojson-vt";
import vtPbf from "vt-pbf";
import { gzip } from "./compress";
import { zxyToTileId } from "./hilbert";
import type { ArchiveTile, GeoJSONFeature, GeoJSONGeometry } from "./types";

/** The single MVT source layer written into every tile. */
export const SOURCE_LAYER_NAME = "geojson";

/** Fixed MVT extent for the whole archive (vector tile spec default). */
export const MVT_EXTENT = 4096;

/** Per-side tile buffer in extent units; near-edge features repeat next door. */
export const TILE_BUFFER_UNITS = 64;

/** Highest latitude representable in web-mercator tile space. */
const WEB_MERCATOR_MAX_LAT = 85.05112877980659;

interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** GeoJSON geometry after GeometryCollections are flattened away. */
type ConcreteGeometry = Exclude<GeoJSONGeometry, { type: "GeometryCollection" }>;

/** A feature after property projection, still in lon/lat degrees. */
interface ProjectedFeature {
  type: "Feature";
  geometry: ConcreteGeometry;
  properties: Record<string, string | number | boolean>;
}

/** Recursively flattens GeometryCollections into their concrete members. */
function flattenGeometry(geometry: GeoJSONGeometry): ConcreteGeometry[] {
  if (geometry.type !== "GeometryCollection") {
    return [geometry];
  }
  const members: ConcreteGeometry[] = [];
  for (const part of geometry.geometries) {
    members.push(...flattenGeometry(part));
  }
  return members;
}

/** Updates `bounds` in place to cover one finite lon/lat position. */
function widenBounds(bounds: Bounds, lon: number, lat: number): void {
  if (lon < bounds.minLon) bounds.minLon = lon;
  if (lat < bounds.minLat) bounds.minLat = lat;
  if (lon > bounds.maxLon) bounds.maxLon = lon;
  if (lat > bounds.maxLat) bounds.maxLat = lat;
}

/** Widens `bounds` to cover every finite position nested under `node`. */
function visitCoordinates(node: unknown, bounds: Bounds): void {
  if (!Array.isArray(node) || node.length === 0) {
    return;
  }
  const first = node[0];
  if (typeof first !== "number") {
    for (const child of node) {
      visitCoordinates(child, bounds);
    }
    return;
  }
  const lon = first;
  const lat = node[1];
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    widenBounds(bounds, lon, lat);
  }
}

/** Overall bounds of one geometry's finite positions, or undefined if none. */
function boundsOfGeometry(geometry: ConcreteGeometry): Bounds | undefined {
  const bounds: Bounds = {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  };
  visitCoordinates(geometry.coordinates, bounds);
  return Number.isFinite(bounds.minLon) ? bounds : undefined;
}

/** Overall bounds over every finite position in the feature collection. */
export function collectionBounds(
  features: readonly (GeoJSONFeature | null | undefined)[],
): Bounds | undefined {
  const bounds: Bounds = {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  };
  let found = false;
  for (const feature of features) {
    if (feature === null || feature === undefined) {
      continue;
    }
    const geometry = feature.geometry;
    if (geometry === null || geometry === undefined) {
      continue;
    }
    for (const part of flattenGeometry(geometry)) {
      visitCoordinates(part.coordinates, bounds);
      if (Number.isFinite(bounds.minLon)) {
        found = true;
      }
    }
  }
  return found ? bounds : undefined;
}

/** Entry id: feature `_id` first, then `properties.entryId`, then `properties._id`. */
function resolveEntryId(feature: GeoJSONFeature): string | undefined {
  if (typeof feature._id === "string") {
    return feature._id;
  }
  const raw = feature.properties;
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const declared = raw["entryId"];
  if (typeof declared === "string") {
    return declared;
  }
  const embedded = raw["_id"];
  if (typeof embedded === "string") {
    return embedded;
  }
  return undefined;
}

function projectProperties(
  feature: GeoJSONFeature,
  includeProperties: readonly string[],
): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {};
  const entryId = resolveEntryId(feature);
  if (entryId !== undefined) {
    properties["entryId"] = entryId;
  }
  if (includeProperties.length === 0) {
    return properties;
  }
  const raw = feature.properties;
  if (raw === null || raw === undefined) {
    return properties;
  }
  for (const key of includeProperties) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      properties[key] = value;
    }
  }
  return properties;
}

function mercatorX(lon: number): number {
  return (lon + 180) / 360;
}

function mercatorY(lat: number): number {
  const clamped = Math.min(WEB_MERCATOR_MAX_LAT, Math.max(-WEB_MERCATOR_MAX_LAT, lat));
  const radians = (clamped * Math.PI) / 180;
  return 0.5 - Math.asinh(Math.tan(radians)) / (2 * Math.PI);
}

function clampTile(value: number, tilesPerSide: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > tilesPerSide - 1) {
    return tilesPerSide - 1;
  }
  return value;
}

/**
 * Inclusive tile-index range covering the bounds plus the buffer pad.
 * Tile rows grow southward while latitude grows northward, so the north
 * edge (`maxLat`) yields the smaller row index and the south edge (`minLat`)
 * the larger one.
 */
function candidateRange(
  bounds: Bounds,
  tilesPerSide: number,
  pad: number,
): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: clampTile(Math.floor((mercatorX(bounds.minLon) - pad) * tilesPerSide), tilesPerSide),
    x1: clampTile(Math.floor((mercatorX(bounds.maxLon) + pad) * tilesPerSide), tilesPerSide),
    y0: clampTile(Math.floor((mercatorY(bounds.maxLat) - pad) * tilesPerSide), tilesPerSide),
    y1: clampTile(Math.floor((mercatorY(bounds.minLat) + pad) * tilesPerSide), tilesPerSide),
  };
}

/** Encodes one geojson-vt tile to gzip-compressed MVT bytes. */
function encodeTile(tile: { features: unknown[] }): Uint8Array {
  const pbf = vtPbf.fromGeojsonVt(
    { geojson: tile },
    { extent: MVT_EXTENT, version: 2 },
  );
  return gzip(new Uint8Array(pbf));
}

/** Projects every renderable feature onto the id-only property projection. */
function projectAll(
  features: readonly (GeoJSONFeature | null | undefined)[],
  includeProperties: readonly string[],
): ProjectedFeature[] {
  const projected: ProjectedFeature[] = [];
  for (const feature of features) {
    if (feature === null || feature === undefined) {
      continue;
    }
    const geometry = feature.geometry;
    if (geometry === null || geometry === undefined) {
      continue;
    }
    const properties = projectProperties(feature, includeProperties);
    for (const part of flattenGeometry(geometry)) {
      projected.push({ type: "Feature", geometry: part, properties });
    }
  }
  return projected;
}

/** Collects every non-empty geojson-vt tile the features reach, tile-id sorted. */
function collectTiles(
  index: GeoJSONVT,
  projected: readonly ProjectedFeature[],
  minZoom: number,
  maxZoom: number,
): ArchiveTile[] {
  const seen = new Set<number>();
  const tiles: ArchiveTile[] = [];
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const tilesPerSide = 2 ** z;
    const pad = TILE_BUFFER_UNITS / MVT_EXTENT / tilesPerSide;
    for (const feature of projected) {
      const bounds = boundsOfGeometry(feature.geometry);
      if (bounds === undefined) {
        continue;
      }
      const { x0, x1, y0, y1 } = candidateRange(bounds, tilesPerSide, pad);
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const tile = tileFor(index, seen, z, x, y);
          if (tile !== undefined) {
            tiles.push(tile);
          }
        }
      }
    }
  }
  return tiles.toSorted((a, b) => a.tileId - b.tileId);
}

/** Fetches and encodes one tile, skipping empty and already-seen tiles. */
function tileFor(
  index: GeoJSONVT,
  seen: Set<number>,
  z: number,
  x: number,
  y: number,
): ArchiveTile | undefined {
  const tileId = zxyToTileId(z, x, y);
  if (seen.has(tileId)) {
    return undefined;
  }
  seen.add(tileId);
  const tile = index.getTile(z, x, y);
  if (tile === null || tile.features.length === 0) {
    return undefined;
  }
  return { tileId, data: encodeTile(tile) };
}

/**
 * Slices the projected collection with geojson-vt and emits every non-empty
 * tile from minZoom through maxZoom that the features geometrically reach
 * (tile bounds plus the shared buffer), as gzip-compressed MVT sorted by
 * ascending Hilbert tile id.
 */
export function tileFeatures(
  features: readonly (GeoJSONFeature | null | undefined)[],
  minZoom: number,
  maxZoom: number,
  includeProperties: readonly string[],
): ArchiveTile[] {
  const projected = projectAll(features, includeProperties);
  if (projected.length === 0) {
    return [];
  }
  const index = new GeoJSONVT(
    { type: "FeatureCollection", features: projected },
    { maxZoom, extent: MVT_EXTENT, buffer: TILE_BUFFER_UNITS },
  );
  return collectTiles(index, projected, minZoom, maxZoom);
}

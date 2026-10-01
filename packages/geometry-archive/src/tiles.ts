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

/** Encodes one geojson-vt tile to gzip-compressed MVT bytes. */
function encodeTile(tile: { features: unknown[] }): Uint8Array {
  const pbf = vtPbf.fromGeojsonVt({ geojson: tile }, { extent: MVT_EXTENT, version: 2 });
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

/**
 * Encodes every non-empty tile the index built between minZoom and maxZoom,
 * tile-id sorted. The index is constructed fully eager (see
 * {@link tileFeatures}), so `tileCoords` is exactly the tiles geojson-vt
 * populated plus their immediate empty neighbors — one `getTile` per
 * candidate, no per-feature bbox sweep. (The sweep this replaced walked each
 * feature's full mercator tile range at every zoom, which an
 * antimeridian-crossing island chain turned into millions of empty-tile
 * probes per build; issue #134.) Buffer repeats need no extra handling —
 * geojson-vt's clip windows carry a near-edge feature into the neighboring
 * tiles themselves.
 */
function collectTiles(index: GeoJSONVT, minZoom: number, maxZoom: number): ArchiveTile[] {
  const tiles: ArchiveTile[] = [];
  for (const coord of index.tileCoords) {
    if (coord.z < minZoom || coord.z > maxZoom) {
      continue;
    }
    const tile = index.getTile(coord.z, coord.x, coord.y);
    if (tile === null || tile.features.length === 0) {
      continue;
    }
    tiles.push({ tileId: zxyToTileId(coord.z, coord.x, coord.y), data: encodeTile(tile) });
  }
  return tiles.toSorted((a, b) => a.tileId - b.tileId);
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
    {
      // Fully eager indexing along populated paths: the defaults index only
      // z ≤ 5 and drill down lazily per lookup, which left enumeration to a
      // per-feature bbox sweep. With `indexMaxZoom: maxZoom` and
      // `indexMaxPoints: 0` the eager pass reaches maxZoom everywhere the
      // features reach, and `tileCoords` — documented public API — lists
      // exactly the tiles geojson-vt populated plus their immediate empty
      // neighbors for {@link collectTiles} to walk. That is the antimeridian
      // fix: a dateline-crossing feature's ~360° bbox made the sweep walk
      // the full tile row at every zoom (issue #134). Total clip work is the
      // same set of tiles the lazy drills would have built, minus their
      // repeated per-lookup descent.
      maxZoom,
      indexMaxZoom: maxZoom,
      indexMaxPoints: 0,
      extent: MVT_EXTENT,
      buffer: TILE_BUFFER_UNITS,
    },
  );
  return collectTiles(index, minZoom, maxZoom);
}

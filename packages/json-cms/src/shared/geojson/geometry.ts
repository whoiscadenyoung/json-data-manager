import turfBbox from "@turf/bbox";

import { GeoParseError, GeometryError } from "./error.js";
import type { Feature, FeatureCollection, Geometry } from "./types.js";

export type BoundingBox = [number, number, number, number];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A [longitude, latitude(, altitude)] position per RFC 7946 §3.1.1. Returned unmodified (altitude preserved) so geometry round-trips losslessly. */
function assertPosition(position: unknown, context: string): number[] {
  if (!Array.isArray(position) || (position.length !== 2 && position.length !== 3)) {
    throw new GeoParseError(
      `${context}: a position must have 2 or 3 coordinate values (longitude, latitude[, altitude]), got ${JSON.stringify(position)}`,
    );
  }
  const [longitude, latitude] = position;
  if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
    throw new GeometryError(
      `${context}: longitude must be a finite number in [-180, 180], got ${longitude}`,
    );
  }
  if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
    throw new GeometryError(
      `${context}: latitude must be a finite number in [-90, 90], got ${latitude}`,
    );
  }
  return position;
}

function assertLineStringCoordinates(coordinates: unknown, context: string): number[][] {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    const length = Array.isArray(coordinates) ? coordinates.length : typeof coordinates;
    throw new GeoParseError(
      `${context}: a LineString must contain at least 2 positions, got ${length}`,
    );
  }
  return coordinates.map((p, i) => assertPosition(p, `${context}[${i}]`));
}

/** A linear ring: at least 4 positions, first and last equal (closed). */
function assertLinearRing(ring: unknown, context: string): number[][] {
  if (!Array.isArray(ring) || ring.length < 4) {
    const length = Array.isArray(ring) ? ring.length : typeof ring;
    throw new GeoParseError(
      `${context}: a linear ring must contain at least 4 positions, got ${length}`,
    );
  }
  const positions = ring.map((p, i) => assertPosition(p, `${context}[${i}]`)),
    first = positions[0],
    last = positions[positions.length - 1];
  const closed =
    first !== undefined &&
    last !== undefined &&
    first.length === last.length &&
    first.every((value, i) => value === last[i]);
  if (!closed) {
    throw new GeometryError(
      `${context}: a linear ring must be closed (first position must equal last position); got first ${JSON.stringify(first)}, last ${JSON.stringify(last)}`,
    );
  }
  return positions;
}

function assertPolygonCoordinates(coordinates: unknown, context: string): number[][][] {
  if (!Array.isArray(coordinates) || coordinates.length < 1) {
    const length = Array.isArray(coordinates) ? coordinates.length : typeof coordinates;
    throw new GeoParseError(
      `${context}: a Polygon must contain at least one linear ring, got ${length}`,
    );
  }
  return coordinates.map((ring, i) => assertLinearRing(ring, `${context}[${i}]`));
}

function assertMultiPoint(coordinates: unknown): Geometry {
  if (!Array.isArray(coordinates)) {
    throw new GeoParseError(
      `MultiPoint.coordinates must be an array, got ${JSON.stringify(coordinates)}`,
    );
  }
  return {
    type: "MultiPoint",
    coordinates: coordinates.map((p, i) => assertPosition(p, `MultiPoint.coordinates[${i}]`)),
  };
}

function assertMultiLineString(coordinates: unknown): Geometry {
  if (!Array.isArray(coordinates)) {
    throw new GeoParseError(
      `MultiLineString.coordinates must be an array, got ${JSON.stringify(coordinates)}`,
    );
  }
  return {
    type: "MultiLineString",
    coordinates: coordinates.map((line, i) =>
      assertLineStringCoordinates(line, `MultiLineString.coordinates[${i}]`),
    ),
  };
}

function assertMultiPolygon(coordinates: unknown): Geometry {
  if (!Array.isArray(coordinates)) {
    throw new GeoParseError(
      `MultiPolygon.coordinates must be an array, got ${JSON.stringify(coordinates)}`,
    );
  }
  return {
    type: "MultiPolygon",
    coordinates: coordinates.map((polygon, i) =>
      assertPolygonCoordinates(polygon, `MultiPolygon.coordinates[${i}]`),
    ),
  };
}

/** Per-type dispatch table used by `assertGeometry` so the type switch itself stays a flat lookup rather than a long if-chain. */
const GEOMETRY_ASSERTERS: Record<string, (coordinates: unknown) => Geometry> = {
  LineString: (coordinates) => ({
    type: "LineString",
    coordinates: assertLineStringCoordinates(coordinates, "LineString.coordinates"),
  }),
  MultiLineString: assertMultiLineString,
  MultiPoint: assertMultiPoint,
  MultiPolygon: assertMultiPolygon,
  Point: (coordinates) => ({
    type: "Point",
    coordinates: assertPosition(coordinates, "Point.coordinates"),
  }),
  Polygon: (coordinates) => ({
    type: "Polygon",
    coordinates: assertPolygonCoordinates(coordinates, "Polygon.coordinates"),
  }),
};

/**
 * Validates and narrows an unknown value to a `Geometry` per RFC 7946.
 * `GeometryCollection` is rejected outright (see shared/geojson/types.ts).
 * @throws {GeoParseError} if the shape is structurally invalid.
 * @throws {GeometryError} if a position is out of range, a ring isn't closed, or the type is GeometryCollection.
 */
export function assertGeometry(input: unknown): Geometry {
  if (input === null || typeof input !== "object" || !("type" in input)) {
    throw new GeoParseError(
      `geometry must be an object with a "type" field, got ${JSON.stringify(input)}`,
    );
  }
  const { type } = input,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `type` is guaranteed present on `input` at this point; `coordinates` may be absent (each geometry-specific asserter below checks for it).
    { coordinates } = input as { coordinates?: unknown };

  if (type === "GeometryCollection") {
    throw new GeometryError('"GeometryCollection" is not a supported geometry type');
  }
  if (typeof type !== "string") {
    throw new GeoParseError(`Unknown geometry type: ${JSON.stringify(type)}`);
  }

  const assert = GEOMETRY_ASSERTERS[type];
  if (assert === undefined) {
    throw new GeoParseError(`Unknown geometry type: ${JSON.stringify(type)}`);
  }
  return assert(coordinates);
}

/** Attempts to validate `input` as a `Geometry`. Returns false for GeometryCollection too. */
export function isValidGeometry(input: unknown): boolean {
  try {
    assertGeometry(input);
    return true;
  } catch {
    return false;
  }
}

/** Reads the four planar bounds out of a Turf `BBox`, which may carry 3D bounds (length 6). */
function planarBounds(result: number[]): [number, number, number, number] {
  return result.length === 6
    ? [result[0], result[1], result[3], result[4]]
    : [result[0], result[1], result[2], result[3]];
}

/**
 * Bounding box of a Geometry/Feature/FeatureCollection via `@turf/bbox`.
 * @returns `undefined` when there are no positions to bound, rather than Turf's own degenerate `[Infinity, Infinity, -Infinity, -Infinity]`.
 */
export function computeBbox(
  input: Geometry | Feature | FeatureCollection,
): BoundingBox | undefined {
  const result = turfBbox(input),
    [minLon, minLat, maxLon, maxLat] = planarBounds(result);
  if (
    !Number.isFinite(minLon) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLon) ||
    !Number.isFinite(maxLat)
  ) {
    return undefined;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Unions two optional bounding boxes: returns whichever one is defined if
 * only one is, the min/max envelope of both if both are defined, or
 * `undefined` if neither is. Used to grow a dataset-level denormalized
 * `boundingBox` as geometries are added, without rescanning every geometry.
 */
export function unionBbox(
  a: BoundingBox | undefined,
  b: BoundingBox | undefined,
): BoundingBox | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

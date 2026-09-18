import { describe, expect, it } from "vitest";

import { GeoParseError, GeometryError } from "./error.js";
import {
  GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
  assertGeometry,
  computeBbox,
  isValidGeometry,
  roundGeometryCoordinates,
  unionBbox,
} from "./geometry.js";
import type { Polygon } from "./types.js";

const validPoint = { coordinates: [10, 20], type: "Point" },
  validLineString = {
    coordinates: [
      [0, 0],
      [1, 1],
    ],
    type: "LineString",
  },
  validPolygon = {
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    type: "Polygon",
  },
  validMultiPolygon = {
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    ],
    type: "MultiPolygon",
  },
  pointOutOfRange = { coordinates: [200, 20], type: "Point" },
  lineStringTooShort = { coordinates: [[0, 0]], type: "LineString" },
  polygonRingTooShort = {
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
    ],
    type: "Polygon",
  },
  polygonRingNotClosed = {
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [2, 2],
      ],
    ],
    type: "Polygon",
  },
  geometryCollection = { geometries: [], type: "GeometryCollection" };

describe("assertGeometry", () => {
  it("accepts a valid Point", () => {
    expect(assertGeometry(validPoint)).toStrictEqual(validPoint);
  });

  it("accepts a valid LineString", () => {
    expect(assertGeometry(validLineString)).toStrictEqual(validLineString);
  });

  it("accepts a valid Polygon", () => {
    expect(assertGeometry(validPolygon)).toStrictEqual(validPolygon);
  });

  it("accepts a valid MultiPolygon", () => {
    expect(assertGeometry(validMultiPolygon)).toStrictEqual(validMultiPolygon);
  });

  it("rejects a Point with out-of-range longitude", () => {
    expect(() => assertGeometry(pointOutOfRange)).toThrow(GeometryError);
  });

  it("rejects a LineString with only 1 position", () => {
    expect(() => assertGeometry(lineStringTooShort)).toThrow(GeoParseError);
  });

  it("rejects a Polygon ring with only 3 positions", () => {
    expect(() => assertGeometry(polygonRingTooShort)).toThrow(GeoParseError);
  });

  it("rejects a Polygon ring that isn't closed", () => {
    expect(() => assertGeometry(polygonRingNotClosed)).toThrow(GeometryError);
  });

  it("rejects GeometryCollection", () => {
    expect(() => assertGeometry(geometryCollection)).toThrow(GeometryError);
  });
});

describe("isValidGeometry", () => {
  it("returns true for valid geometries", () => {
    expect(isValidGeometry(validPoint)).toBe(true);
    expect(isValidGeometry(validLineString)).toBe(true);
    expect(isValidGeometry(validPolygon)).toBe(true);
    expect(isValidGeometry(validMultiPolygon)).toBe(true);
  });

  it("returns false for invalid geometries", () => {
    expect(isValidGeometry(pointOutOfRange)).toBe(false);
    expect(isValidGeometry(lineStringTooShort)).toBe(false);
    expect(isValidGeometry(polygonRingTooShort)).toBe(false);
    expect(isValidGeometry(polygonRingNotClosed)).toBe(false);
    expect(isValidGeometry(geometryCollection)).toBe(false);
  });
});

describe("computeBbox", () => {
  it("returns a degenerate box for a Point", () => {
    expect(computeBbox(assertGeometry(validPoint))).toStrictEqual([10, 20, 10, 20]);
  });

  it("returns a sensible box for a Polygon", () => {
    const square = assertGeometry({
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      type: "Polygon",
    });
    expect(computeBbox(square)).toStrictEqual([0, 0, 2, 2]);
  });

  it("returns undefined for a MultiPoint with no coordinates", () => {
    expect(computeBbox({ coordinates: [], type: "MultiPoint" })).toBeUndefined();
  });
});

describe("roundGeometryCoordinates", () => {
  it("rounds Point coordinates to the given precision", () => {
    const point = assertGeometry({ coordinates: [10.123456789, 20.987654321], type: "Point" });
    expect(roundGeometryCoordinates(point, 6)).toStrictEqual({
      coordinates: [10.123457, 20.987654],
      type: "Point",
    });
  });

  it("rounds through every nesting level of a MultiPolygon", () => {
    const multiPolygon = assertGeometry({
      coordinates: [
        [
          [
            [0.123456789, 0.987654321],
            [1.111111111, 0],
            [1, 1.000000001],
            [0.123456789, 0.987654321],
          ],
        ],
      ],
      type: "MultiPolygon",
    });
    expect(roundGeometryCoordinates(multiPolygon, 4)).toStrictEqual({
      coordinates: [
        [
          [
            [0.1235, 0.9877],
            [1.1111, 0],
            [1, 1],
            [0.1235, 0.9877],
          ],
        ],
      ],
      type: "MultiPolygon",
    });
  });

  it("preserves a third altitude value while rounding it too", () => {
    const point = assertGeometry({
      coordinates: [10.123456789, 20.987654321, 55.5555555],
      type: "Point",
    });
    expect(roundGeometryCoordinates(point, 2).coordinates[2]).toBe(55.56);
  });

  it("is idempotent — rounding an already-rounded geometry changes nothing", () => {
    const polygon = assertGeometry({
      coordinates: [
        [
          [-70.9232015429999, 41.4822198969999],
          [-70.92101, 41.48245],
          [-70.9205, 41.48301],
          [-70.9232015429999, 41.4822198969999],
        ],
      ],
      type: "Polygon",
    });
    const once = roundGeometryCoordinates(polygon, GEOMETRY_SIMPLIFY_DECIMAL_PLACES);
    expect(roundGeometryCoordinates(once, GEOMETRY_SIMPLIFY_DECIMAL_PLACES)).toStrictEqual(once);
  });

  it("never lengthens the serialized payload", () => {
    const noisy = assertGeometry({
      coordinates: [
        [
          [-123.10803331604004, 27.57055507199985],
          [-70.92320154299999, 48.14650260899995],
          [-70.9201, 48.14701],
          [-123.10803331604004, 27.57055507199985],
        ],
      ],
      type: "Polygon",
    });
    const roundedJson = JSON.stringify(
      roundGeometryCoordinates(noisy, GEOMETRY_SIMPLIFY_DECIMAL_PLACES),
    );
    expect(roundedJson.length).toBeLessThanOrEqual(JSON.stringify(noisy).length);
  });

  it("leaves ring closure intact", () => {
    const closed = assertGeometry({
      coordinates: [
        [
          [0.123456789, 0.987654321],
          [1, 1],
          [2, 2],
          [0.123456789, 0.987654321],
        ],
      ],
      type: "Polygon",
    });
    const rounded = (roundGeometryCoordinates(closed, 3).coordinates as Polygon["coordinates"])[0];
    expect(rounded[0]).toStrictEqual(rounded[rounded.length - 1]);
  });
});

describe("unionBbox", () => {
  it("returns the other box when one side is undefined", () => {
    const box: [number, number, number, number] = [0, 0, 1, 1];
    expect(unionBbox(box, undefined)).toStrictEqual(box);
    expect(unionBbox(undefined, box)).toStrictEqual(box);
  });

  it("returns undefined when both sides are undefined", () => {
    expect(unionBbox(undefined, undefined)).toBeUndefined();
  });

  it("returns the min/max envelope of two overlapping boxes", () => {
    const a: [number, number, number, number] = [0, 0, 2, 2],
      b: [number, number, number, number] = [1, 1, 3, 3];
    expect(unionBbox(a, b)).toStrictEqual([0, 0, 3, 3]);
  });

  it("returns the min/max envelope of two disjoint boxes", () => {
    const a: [number, number, number, number] = [-10, -10, -5, -5],
      b: [number, number, number, number] = [5, 5, 10, 10];
    expect(unionBbox(a, b)).toStrictEqual([-10, -10, 10, 10]);
  });
});

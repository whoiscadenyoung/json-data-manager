import { describe, expect, it } from "vitest";

import { GeoParseError, GeometryError } from "./error.js";
import { assertGeometry, computeBbox, isValidGeometry, unionBbox } from "./geometry.js";

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

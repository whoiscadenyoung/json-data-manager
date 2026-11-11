import { describe, expect, test } from "bun:test";

import { suggestMaxZoom } from "./index";
import type { GeoJSONFeature } from "./types";

function point(lon: number, lat: number): GeoJSONFeature {
  return {
    type: "Feature",
    _id: `${lon},${lat}`,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: null,
  } as unknown as GeoJSONFeature;
}

function box(minLon: number, minLat: number, maxLon: number, maxLat: number): GeoJSONFeature {
  return {
    type: "Feature",
    _id: "box",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
    properties: null,
  } as unknown as GeoJSONFeature;
}

describe("suggestMaxZoom", () => {
  test("points keep the requested max zoom", () => {
    const points = Array.from({ length: 1000 }, (_, i) => point(-100 + i * 0.01, 35));
    expect(suggestMaxZoom(points, 0, 14, 1_000_000)).toBe(14);
  });

  test("a continent-sized polygon drops below the max zoom", () => {
    const zoom = suggestMaxZoom([box(-125, 25, -67, 49)], 0, 14, 1_000_000);
    expect(zoom).toBeLessThan(14);
    expect(zoom).toBeGreaterThan(6);
  });

  test("an empty collection keeps the requested max zoom", () => {
    expect(suggestMaxZoom([], 0, 14, 1_000_000)).toBe(14);
  });

  test("never returns below minZoom", () => {
    expect(suggestMaxZoom([box(-180, -80, 180, 80)], 2, 14, 1)).toBe(2);
  });

  test("points beyond the budget still keep the requested max zoom", () => {
    const points = Array.from({ length: 50 }, (_, i) => point(-100 + i * 0.01, 35));
    expect(suggestMaxZoom(points, 0, 14, 10)).toBe(14);
  });

  test("a state-sized tiling stays below z13 under the worker budget", () => {
    // 48 boxes of 7.2 x 4 degrees: measured 46 s / +750 MB at z13 with dense rings.
    const boxes = Array.from({ length: 48 }, (_, i) => {
      const lon = -124 + (i % 8) * 7.2,
        lat = 25 + Math.floor(i / 8) * 4;
      return box(lon, lat, lon + 7.2, lat + 4);
    });
    expect(suggestMaxZoom(boxes, 0, 14, 400_000)).toBe(12);
  });
});

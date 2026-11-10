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
});

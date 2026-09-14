import { describe, expect, it } from "vitest";

import { looksLikeGeoJson, parseGeoJsonFeatures } from "./geojson-import.js";

function polygonFeature(properties: Record<string, unknown> = {}) {
  return {
    geometry: {
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
    properties,
    type: "Feature",
  };
}

function multiPolygonFeature(properties: Record<string, unknown> = {}) {
  return {
    geometry: {
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
    properties,
    type: "Feature",
  };
}

function pointFeature(properties: Record<string, unknown> = {}) {
  return { geometry: { coordinates: [0, 0], type: "Point" }, properties, type: "Feature" };
}

function multiPointFeature(properties: Record<string, unknown> = {}) {
  return {
    geometry: { coordinates: [[0, 0]], type: "MultiPoint" },
    properties,
    type: "Feature",
  };
}

describe("looksLikeGeoJson", () => {
  it("is true for a FeatureCollection object", () => {
    expect(looksLikeGeoJson({ features: [pointFeature()], type: "FeatureCollection" })).toBe(true);
  });

  it("is true for a bare array of Feature-shaped objects", () => {
    expect(looksLikeGeoJson([pointFeature(), polygonFeature()])).toBe(true);
  });

  it("is false for a plain array of data objects with no .type", () => {
    expect(looksLikeGeoJson([{ age: 36, name: "Ada" }])).toBe(false);
  });

  it("is false for an empty array (ambiguous)", () => {
    expect(looksLikeGeoJson([])).toBe(false);
  });

  it("is false for a single plain object", () => {
    expect(looksLikeGeoJson({ age: 36, name: "Ada" })).toBe(false);
  });

  it("is false for null and primitives", () => {
    expect(looksLikeGeoJson(null)).toBe(false);
    expect(looksLikeGeoJson(42)).toBe(false);
    expect(looksLikeGeoJson("hello")).toBe(false);
    expect(looksLikeGeoJson(undefined)).toBe(false);
  });
});

describe("parseGeoJsonFeatures", () => {
  it("coalesces 2 Polygon + 1 MultiPolygon features to MultiPolygon", () => {
    const result = parseGeoJsonFeatures({
      features: [polygonFeature(), polygonFeature(), multiPolygonFeature()],
      type: "FeatureCollection",
    });
    expect(result.rows).toHaveLength(3);
    expect(result.geometryType).toBe("MultiPolygon");
    expect(result.coalesceError).toBeUndefined();
    expect(result.errors).toStrictEqual([]);
    expect(result.typeCounts).toStrictEqual({ MultiPolygon: 1, Polygon: 2 });
  });

  it("reports a coalesceError for incompatible Point + MultiPoint features", () => {
    const result = parseGeoJsonFeatures({
      features: [pointFeature(), multiPointFeature()],
      type: "FeatureCollection",
    });
    expect(result.rows).toHaveLength(2);
    expect(result.geometryType).toBeNull();
    expect(result.coalesceError).toBeDefined();
  });

  it("includes a null-geometry Feature as a geometry-less row, excluded from coalescing", () => {
    const result = parseGeoJsonFeatures({
      features: [
        polygonFeature({ name: "a" }),
        { geometry: null, properties: { name: "b" }, type: "Feature" },
        polygonFeature({ name: "c" }),
      ],
      type: "FeatureCollection",
    });
    expect(result.rows).toHaveLength(3);
    const geometryless = result.rows.find((row) => row.geometry === undefined);
    expect(geometryless).toBeDefined();
    expect(geometryless === undefined ? undefined : geometryless.data).toStrictEqual({
      name: "b",
    });
    expect(result.geometryType).toBe("Polygon");
    expect(result.coalesceError).toBeUndefined();
    expect(result.typeCounts).toStrictEqual({ Polygon: 2 });
  });

  it("skips a malformed feature (out-of-range coordinates) and reports it by index", () => {
    const malformed = {
        geometry: { coordinates: [200, 0], type: "Point" },
        properties: { name: "bad" },
        type: "Feature",
      },
      result = parseGeoJsonFeatures({
        features: [polygonFeature({ name: "good1" }), malformed, polygonFeature({ name: "good2" })],
        type: "FeatureCollection",
      });
    expect(result.rows).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    const [firstError] = result.errors;
    expect(firstError).toBeDefined();
    expect(firstError === undefined ? undefined : firstError.index).toBe(1);
    expect(result.geometryType).toBe("Polygon");
  });

  it("handles a bare array of Features the same as a FeatureCollection", () => {
    const result = parseGeoJsonFeatures([
      polygonFeature(),
      polygonFeature(),
      multiPolygonFeature(),
    ]);
    expect(result.rows).toHaveLength(3);
    expect(result.geometryType).toBe("MultiPolygon");
    expect(result.errors).toStrictEqual([]);
  });

  it("returns empty results for an empty features array", () => {
    const result = parseGeoJsonFeatures({ features: [], type: "FeatureCollection" });
    expect(result.rows).toStrictEqual([]);
    expect(result.geometryType).toBeNull();
    expect(result.errors).toStrictEqual([]);
    expect(result.coalesceError).toBeUndefined();
    expect(result.typeCounts).toStrictEqual({});
  });
});

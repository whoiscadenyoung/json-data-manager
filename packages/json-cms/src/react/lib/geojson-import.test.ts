import { describe, expect, it } from "vitest";

import {
  collidingFeatureFields,
  looksLikeGeoJson,
  mergeFeatureFields,
  parseGeoJsonFeatures,
} from "./geojson-import.js";

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

describe("parent-level feature fields", () => {
  it("captures id and other parent-level members, excluding type/geometry/properties", () => {
    const feature = {
        ...pointFeature({ name: "Route 9" }),
        id: "corridor-001",
        verified: "2026-10-01",
      },
      result = parseGeoJsonFeatures({ features: [feature], type: "FeatureCollection" });
    expect(result.featureFields).toStrictEqual([
      { count: 1, key: "id" },
      { count: 1, key: "verified" },
    ]);
    expect(result.rows[0].featureFields).toStrictEqual({
      id: "corridor-001",
      verified: "2026-10-01",
    });
    // The row data stays byte-faithful to the properties until a field is
    // explicitly preserved.
    expect(result.rows[0].data).toStrictEqual({ name: "Route 9" });
  });

  it("counts per-field presence across features, most-present first", () => {
    const features = [
        { ...pointFeature({ name: "A" }), id: "a" },
        { ...pointFeature({ name: "B" }), id: "b", note: "extra" },
      ],
      result = parseGeoJsonFeatures({ features, type: "FeatureCollection" });
    expect(result.featureFields).toStrictEqual([
      { count: 2, key: "id" },
      { count: 1, key: "note" },
    ]);
  });

  it("reports no candidates for bare standard features", () => {
    const result = parseGeoJsonFeatures({ features: [pointFeature()], type: "FeatureCollection" });
    expect(result.featureFields).toStrictEqual([]);
  });
});

describe("mergeFeatureFields", () => {
  it("folds selected parent-level fields into a copy of the properties", () => {
    const row = parseGeoJsonFeatures({
        features: [{ ...pointFeature({ name: "A" }), id: "a", note: "n" }],
        type: "FeatureCollection",
      }).rows[0],
      merged = mergeFeatureFields(row, ["id"]);
    expect(merged).toStrictEqual({ id: "a", name: "A" });
    // The source row's data is untouched (the merge returns a new record).
    expect(row.data).toStrictEqual({ name: "A" });
  });

  it("lets a preserved field win over a same-named property", () => {
    const row = parseGeoJsonFeatures({
        features: [{ ...pointFeature({ id: "property-id" }), id: "feature-id" }],
        type: "FeatureCollection",
      }).rows[0],
      merged = mergeFeatureFields(row, ["id"]);
    expect(merged).toStrictEqual({ id: "feature-id" });
  });

  it("returns the exact properties shape when the selection is empty", () => {
    const row = parseGeoJsonFeatures({
        features: [{ ...pointFeature({ name: "A", size: 2 }), id: "a" }],
        type: "FeatureCollection",
      }).rows[0],
      merged = mergeFeatureFields(row, []);
    expect(merged).toStrictEqual({ name: "A", size: 2 });
    expect(merged).not.toBe(row.data);
  });

  it("skips a selected field the row doesn't carry", () => {
    const rows = parseGeoJsonFeatures({
        features: [{ ...pointFeature({ name: "A" }), id: "a" }, pointFeature({ name: "B" })],
        type: "FeatureCollection",
      }).rows,
      merged = mergeFeatureFields(rows[1], ["id"]);
    expect(merged).toStrictEqual({ name: "B" });
  });
});

describe("collidingFeatureFields", () => {
  it("flags selected fields that share a name with a property on a carrying row", () => {
    const rows = parseGeoJsonFeatures({
        features: [
          { ...pointFeature({ id: "property-id", name: "A" }), id: "feature-id" },
          { ...pointFeature({ name: "B" }), verified: "y" },
        ],
        type: "FeatureCollection",
      }).rows,
      collisions = collidingFeatureFields(rows, ["id", "verified"]);
    expect(collisions).toStrictEqual(["id"]);
  });

  it("returns nothing for an empty selection or clean fields", () => {
    const rows = parseGeoJsonFeatures({
      features: [{ ...pointFeature({ name: "A" }), id: "a" }],
      type: "FeatureCollection",
    }).rows;
    expect(collidingFeatureFields(rows, [])).toStrictEqual([]);
    expect(collidingFeatureFields(rows, ["id"])).toStrictEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { coalesceGeometryTypes, isGeometryCompatibleWithDatasetType } from "./coalesce.js";
import { GEOMETRY_TYPES } from "./types.js";
import type { GeometryType } from "./types.js";

describe("coalesceGeometryTypes", () => {
  it.each(GEOMETRY_TYPES)("passes a single %s type through unchanged", (type) => {
    const result = coalesceGeometryTypes([type]);
    expect(result).toStrictEqual({ geometryType: type, ok: true });
  });

  it("coalesces Polygon + MultiPolygon to MultiPolygon", () => {
    const result = coalesceGeometryTypes(["Polygon", "MultiPolygon"]);
    expect(result).toStrictEqual({ geometryType: "MultiPolygon", ok: true });
  });

  it("coalesces MultiPolygon + Polygon (order-independent) to MultiPolygon", () => {
    const result = coalesceGeometryTypes(["MultiPolygon", "Polygon"]);
    expect(result).toStrictEqual({ geometryType: "MultiPolygon", ok: true });
  });

  it("coalesces LineString + MultiLineString to MultiLineString", () => {
    const result = coalesceGeometryTypes(["LineString", "MultiLineString"]);
    expect(result).toStrictEqual({ geometryType: "MultiLineString", ok: true });
  });

  it("rejects Point + MultiPoint", () => {
    const result = coalesceGeometryTypes(["Point", "MultiPoint"]);
    expect(result.ok).toBe(false);
  });

  it("rejects incompatible mixes like Point + Polygon", () => {
    const result = coalesceGeometryTypes(["Point", "Polygon"]);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty batch", () => {
    const result = coalesceGeometryTypes([]);
    expect(result.ok).toBe(false);
  });
});

describe("isGeometryCompatibleWithDatasetType", () => {
  it("a Polygon entry is compatible with a MultiPolygon-locked dataset", () => {
    expect(isGeometryCompatibleWithDatasetType("Polygon", "MultiPolygon")).toBe(true);
  });

  it("a MultiPolygon entry is NOT compatible with a Polygon-locked dataset (asymmetric)", () => {
    expect(isGeometryCompatibleWithDatasetType("MultiPolygon", "Polygon")).toBe(false);
  });

  it("a Point entry is compatible with a Point-locked dataset", () => {
    expect(isGeometryCompatibleWithDatasetType("Point", "Point")).toBe(true);
  });

  it("a Point entry is NOT compatible with a MultiPoint-locked dataset", () => {
    expect(isGeometryCompatibleWithDatasetType("Point", "MultiPoint")).toBe(false);
  });

  it("a MultiPoint entry is NOT compatible with a Point-locked dataset", () => {
    expect(isGeometryCompatibleWithDatasetType("MultiPoint", "Point")).toBe(false);
  });

  it.each(GEOMETRY_TYPES)("a %s entry is always compatible with a same-typed dataset", (type) => {
    const datasetType: GeometryType = type;
    expect(isGeometryCompatibleWithDatasetType(type, datasetType)).toBe(true);
  });
});

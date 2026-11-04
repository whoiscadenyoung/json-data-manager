import { describe, expect, it } from "vitest";

import {
  buildPointFeatureCollection,
  isPointLikeGeometryType,
  pgBboxBounds,
  splitPointLikeGeometries,
} from "./point-geometry";

describe("isPointLikeGeometryType", () => {
  it("treats Point and MultiPoint as point-like", () => {
    expect(isPointLikeGeometryType("Point")).toBe(true);
    expect(isPointLikeGeometryType("MultiPoint")).toBe(true);
  });

  it("treats every other geometry type as not point-like", () => {
    expect(isPointLikeGeometryType("LineString")).toBe(false);
    expect(isPointLikeGeometryType("MultiLineString")).toBe(false);
    expect(isPointLikeGeometryType("Polygon")).toBe(false);
    expect(isPointLikeGeometryType("MultiPolygon")).toBe(false);
  });
});

describe("splitPointLikeGeometries", () => {
  it("partitions rows into point-like and everything else, preserving order", () => {
    const rows = [
      { id: "a", type: "Point" as const },
      { id: "b", type: "Polygon" as const },
      { id: "c", type: "MultiPoint" as const },
      { id: "d", type: "LineString" as const },
    ];

    const { pointRows, otherRows } = splitPointLikeGeometries(rows);

    expect(pointRows.map((r) => r.id)).toStrictEqual(["a", "c"]);
    expect(otherRows.map((r) => r.id)).toStrictEqual(["b", "d"]);
  });

  it("returns empty arrays for no rows", () => {
    expect(splitPointLikeGeometries([])).toStrictEqual({ pointRows: [], otherRows: [] });
  });
});

describe("buildPointFeatureCollection", () => {
  it("passes Point geometries through as single features", () => {
    const collection = buildPointFeatureCollection([
      {
        id: "entry-1",
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { entryId: "entry-1" },
      },
    ]);

    expect(collection).toStrictEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "entry-1",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { entryId: "entry-1" },
        },
      ],
    });
  });

  it("explodes a MultiPoint into one Point feature per coordinate, duplicating properties", () => {
    const collection = buildPointFeatureCollection([
      {
        id: "entry-2",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [1, 2],
            [3, 4],
            [5, 6],
          ],
        },
        properties: { entryId: "entry-2", schemaId: "schema-1" },
      },
    ]);

    expect(collection.features).toHaveLength(3);
    expect(collection.features).toStrictEqual([
      {
        type: "Feature",
        id: "entry-2:0",
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { entryId: "entry-2", schemaId: "schema-1" },
      },
      {
        type: "Feature",
        id: "entry-2:1",
        geometry: { type: "Point", coordinates: [3, 4] },
        properties: { entryId: "entry-2", schemaId: "schema-1" },
      },
      {
        type: "Feature",
        id: "entry-2:2",
        geometry: { type: "Point", coordinates: [5, 6] },
        properties: { entryId: "entry-2", schemaId: "schema-1" },
      },
    ]);
  });

  it("mixes Point and MultiPoint rows and skips non-point geometries defensively", () => {
    const collection = buildPointFeatureCollection([
      {
        id: "entry-1",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { entryId: "entry-1" },
      },
      {
        id: "entry-2",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [1, 1],
            [2, 2],
          ],
        },
        properties: { entryId: "entry-2" },
      },
      {
        id: "entry-3",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately exercising the defensive branch with a geometry type that should never reach this function.
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        } as never,
        properties: { entryId: "entry-3" },
      },
    ]);

    expect(collection.features.map((f) => f.id)).toStrictEqual([
      "entry-1",
      "entry-2:0",
      "entry-2:1",
    ]);
  });
});

describe("pgBboxBounds — the datasets.bbox stored extent (design §3.2)", () => {
  it("unfolds the trigger-maintained envelope polygon into a bounds tuple", () => {
    expect(
      pgBboxBounds({
        coordinates: [
          [
            [-122.5, 37.1],
            [-122.2, 37.1],
            [-122.2, 37.9],
            [-122.5, 37.9],
            [-122.5, 37.1],
          ],
        ],
        type: "Polygon",
      }),
    ).toStrictEqual([-122.5, 37.1, -122.2, 37.9]);
  });

  it("answers the tuple the instant-open surfaces fit once (ui-polish rule)", () => {
    // Ring winding must not matter: st_envelope's ring runs counterclockwise
    // in RFC 7946 order, but the extremes are winding-invariant.
    expect(
      pgBboxBounds({
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 20],
            [0, 20],
            [0, 0],
          ],
        ],
        type: "Polygon",
      }),
    ).toStrictEqual([0, 0, 10, 20]);
  });

  it("reads absent or malformed extents as no stored extent (the skeleton fallback)", () => {
    expect(pgBboxBounds(undefined)).toBeUndefined();
    expect(pgBboxBounds({ coordinates: [[]], type: "Polygon" })).toBeUndefined();
    expect(
      // A wrong-typed payload (PostgREST returning something unexpected)
      // degrades to the fallback instead of throwing mid-render.
      pgBboxBounds({ coordinates: "nope", type: "Polygon" } as unknown as Parameters<
        typeof pgBboxBounds
      >[0]),
    ).toBeUndefined();
  });
});

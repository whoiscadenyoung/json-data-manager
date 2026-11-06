import { describe, expect, it } from "vitest";

import type { DatasetSummaryRow } from "#/lib/store/datasets";

import {
  pgBboxTuple,
  pgEntryToEntryRow,
  pgGeometryToLayerRow,
  pgSummaryToDatasetSummary,
} from "./pg-layer-rows";

function summaryRow(overrides: Partial<DatasetSummaryRow> = {}): DatasetSummaryRow {
  const base = {
    bbox: null,
    createdBy: "creator-1",
    createdAt: "2026-11-03T00:00:00Z",
    description: null,
    editPolicy: "open",
    entryCount: 3,
    featureCount: 5,
    fieldCount: 2,
    geometryType: null,
    groupId: null,
    id: "a44cba20-2b31-4d61-a1f2-0f6b56ca92de",
    isGeospatial: false,
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveBytes: null,
    mapTileCacheVersion: 7,
    publishedVisibility: "everyone",
    source: null,
    title: "Parks",
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fixture overrides are partial by design; the assertion is the base-literal's type.
  return { ...base, ...overrides } as DatasetSummaryRow;
}

describe("pgSummaryToDatasetSummary — the pipeline's projection", () => {
  it("re-keys the summary onto the Convex doc shape (id → _id, isGeospatial → kind)", () => {
    const row = summaryRow({ isGeospatial: true, geometryType: "Point", groupId: "g1" });
    const summary = pgSummaryToDatasetSummary(row);
    expect(summary._id).toBe(row.id);
    expect(summary.kind).toBe("geospatial");
    expect(summary.geometryType).toBe("Point");
    expect(summary.groupId).toBe("g1");
    expect(summary.entryCount).toBe(3);
    expect(summary.mapTileCacheVersion).toBe(7);
    expect(summary.boundingBox).toBeUndefined();
  });

  it("maps the stored envelope to the flat tuple (the Convex summaries' shape)", () => {
    const row = summaryRow({
      bbox: {
        coordinates: [
          [
            [1, 2],
            [10, 2],
            [10, 20],
            [1, 20],
            [1, 2],
          ],
        ],
        type: "Polygon",
      },
    });
    expect(pgSummaryToDatasetSummary(row).boundingBox).toStrictEqual([1, 2, 10, 20]);
  });

  it("an absent envelope stays absent (the full-skeleton fallback path)", () => {
    expect(pgSummaryToDatasetSummary(summaryRow()).boundingBox).toBeUndefined();
  });

  it("archive fields pass through raw (the staleness comparison is the tile workstream's job)", () => {
    const row = summaryRow({ mapTileArchiveBuiltVersion: 7, mapTileArchiveBytes: 1024 });
    const summary = pgSummaryToDatasetSummary(row);
    expect(summary.mapTileArchiveBuiltVersion).toBe(7);
    expect(summary.mapTileArchiveBytes).toBe(1024);
  });
});

describe("pgBboxTuple — the envelope unfold", () => {
  it("folds a closed ring to its coordinate extremes", () => {
    expect(
      pgBboxTuple({
        coordinates: [
          [
            [-5, 0],
            [5, 0],
            [5, 10],
            [-5, 10],
            [-5, 0],
          ],
        ],
        type: "Polygon",
      }),
    ).toStrictEqual([-5, 0, 5, 10]);
  });

  it("answers nothing for a null or non-polygon envelope", () => {
    expect(pgBboxTuple(null)).toBeUndefined();
    expect(pgBboxTuple({ coordinates: [], type: "Point" as never })).toBeUndefined();
  });
});

describe("pgGeometryToLayerRow — the seam row lift", () => {
  it("keys the row by its ENTRY (1:1), names the dataset as schemaId, embeds the resolved payload", () => {
    const row = pgGeometryToLayerRow(
      {
        bbox: [1, 2, 3, 4],
        data: { name: "x" },
        datasetId: "d1",
        entryId: "e1",
        geometry: null,
        sourcePath: "d1/e1.json",
        type: "Point",
      },
      { coordinates: [1, 2], type: "Point" },
    );
    expect(row).toStrictEqual({
      _creationTime: 0,
      _id: "e1",
      entryId: "e1",
      geometryJson: '{"coordinates":[1,2],"type":"Point"}',
      schemaId: "d1",
      type: "Point",
    });
  });

  it("an unresolved row carries no payload (the feature stays absent until resolution)", () => {
    const row = pgGeometryToLayerRow(
      {
        bbox: null,
        data: {},
        datasetId: "d1",
        entryId: "e1",
        geometry: null,
        sourcePath: null,
        type: "Polygon",
      },
      undefined,
    );
    expect(Object.hasOwn(row, "geometryJson")).toBe(false);
    expect(row.type).toBe("Polygon");
  });
});

describe("pgEntryToEntryRow — the popup/field-join lift", () => {
  it("re-keys the store row onto the seam shape (id → _id, datasetId → schemaId)", () => {
    const row = pgEntryToEntryRow({
      createdAt: "2026-11-03T00:00:00Z",
      data: { name: "x" },
      datasetId: "d1",
      geometryType: null,
      id: "e1",
    });
    expect(row).toStrictEqual({
      _creationTime: 0,
      _id: "e1",
      data: { name: "x" },
      schemaId: "d1",
    });
  });
});

import { rememberBelowThresholdSkip } from "@caden/maps/build-scheduler";
import { describe, expect, it } from "vitest";

import {
  geospatialDatasetsFor,
  selectLayerSource,
  TILE_WAIT_MIN_FEATURES,
  splitSchemaIdsByDecision,
  type TileSourceDecision,
} from "./layer-source";
import type { DatasetSummary } from "./map-layers";

function dataset(id: string, kind: "geospatial" | "standard"): DatasetSummary {
  return {
    _creationTime: 0,
    _id: id,
    entryCount: 0,
    featureCount: 0,
    fieldCount: 0,
    kind,
    mapTileArchiveFormatCurrent: true,
    title: `ds-${id}`,
  };
}

describe("splitSchemaIdsByDecision", () => {
  const VECTOR: TileSourceDecision = { kind: "vector", url: "pmtiles://x" },
    ROWS: TileSourceDecision = { kind: "rows" },
    decisions = new Map<string, TileSourceDecision>([
      ["tiled", VECTOR],
      ["rowish", ROWS],
    ]);

  it("files component ids under the path their decision names", () => {
    const split = splitSchemaIdsByDecision(["tiled", "rowish"], decisions);
    expect(split.tileSources).toStrictEqual([{ schemaId: "tiled", url: "pmtiles://x" }]);
    expect(split.rowSchemaIds).toStrictEqual(["rowish"]);
    expect(split.derivedRowIds).toStrictEqual([]);
    expect(split.sourcesPending).toBe(false);
  });

  it("flags a pending decision instead of picking either path", () => {
    const withPending = new Map<string, TileSourceDecision>([
      ["tiled", VECTOR],
      ["pending", { kind: "pending" }],
    ]);
    const split = splitSchemaIdsByDecision(["tiled", "pending"], withPending);
    expect(split.sourcesPending).toBe(true);
    expect(split.rowSchemaIds).toStrictEqual([]);
    expect(split.tileSources).toHaveLength(1);
  });

  it("still drops a component id without a decision (a non-geospatial dataset)", () => {
    const split = splitSchemaIdsByDecision(["rowish", "standard"], decisions);
    expect(split.rowSchemaIds).toStrictEqual(["rowish"]);
  });

  it("takes derived ids explicitly onto the row path even though no decision exists for them (3a's rule)", () => {
    const split = splitSchemaIdsByDecision(["tiled"], decisions, ["d1", "d2"]);
    expect(split.derivedRowIds).toStrictEqual(["d1", "d2"]);
    expect(split.rowSchemaIds).toStrictEqual([]);
    // A derived id with no decision must never re-enter the decision split.
    const unlisted = splitSchemaIdsByDecision(["d1"], decisions, []);
    expect(unlisted.derivedRowIds).toStrictEqual([]);
    expect(unlisted.rowSchemaIds).toStrictEqual([]);
  });
});

describe("geospatialDatasetsFor", () => {
  it("passes only component geospatial rows to the tile decision", () => {
    const datasets = [dataset("s1", "geospatial"), dataset("s2", "standard")],
      rows = geospatialDatasetsFor(["s1", "s2", "d1"], datasets);
    // The derived registry id "d1" has no schemas row and drops out here —
    // it can never reach useTileArchiveSources (the explicit 3a rule).
    expect(rows.map((row) => row._id)).toStrictEqual(["s1"]);
  });

  it("answers nothing while the dataset list is still loading", () => {
    expect(geospatialDatasetsFor(["s1"], undefined)).toStrictEqual([]);
  });
});

describe("selectLayerSource: waiting for the first archive (#185)", () => {
  const large = {
    _id: "big",
    featureCount: TILE_WAIT_MIN_FEATURES,
    geometryType: "Point",
    kind: "geospatial" as const,
    mapTileCacheVersion: 3,
  };

  it("holds the row path for a large dataset with no archive yet", () => {
    expect(selectLayerSource(large, undefined)).toStrictEqual({ kind: "pending" });
  });

  it("keeps rows for small datasets, stale-but-built archives and unwritten datasets", () => {
    expect(
      selectLayerSource({ ...large, featureCount: TILE_WAIT_MIN_FEATURES - 1 }, undefined),
    ).toStrictEqual({ kind: "rows" });
    expect(selectLayerSource({ ...large, mapTileArchiveBuiltVersion: 2 }, undefined)).toStrictEqual(
      { kind: "rows" },
    );
    expect(selectLayerSource({ ...large, mapTileCacheVersion: 0 }, undefined)).toStrictEqual({
      kind: "rows",
    });
  });

  it("falls back to rows after a failed build", () => {
    expect(selectLayerSource(large, undefined, true)).toStrictEqual({ kind: "rows" });
  });

  it("falls back to rows once the build was skipped as below-threshold", () => {
    rememberBelowThresholdSkip("big-skipped", 3);
    expect(selectLayerSource({ ...large, _id: "big-skipped" }, undefined)).toStrictEqual({
      kind: "rows",
    });
  });
});

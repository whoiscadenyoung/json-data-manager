// @vitest-environment jsdom
import { rememberBelowThresholdSkip } from "@caden/maps/build-scheduler";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The hook's metas subscription is scripted, not real: a controlled map.
// The PG feed's core chain reaches `#/env` (store client → integrations
// client, validated at import time) and the query-client singleton — CI has
// no .env.local and the harness needs neither (stage-3-ci-tree-lessons).
vi.mock("#/env", () => ({
  env: {
    VITE_SUPABASE_ANON_KEY: "test-anon-key",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  },
}));
vi.mock("#/integrations/tanstack-query/root-provider", () => ({
  getContext: () => ({ queryClient: { invalidateQueries: () => undefined } }),
}));

const mocks = vi.hoisted(() => ({
  metas: undefined as
    | globalThis.Map<string, { datasetId: string; url: string; version: number }>
    | undefined,
}));

vi.mock("./tile-archive-state-react", () => ({
  useTileDatasetSummaries: () => undefined,
  useTileArchiveMetas: () => mocks.metas,
}));

import {
  selectLayerSource,
  TILE_WAIT_MIN_FEATURES,
  splitDatasetIdsByDecision,
  useTileArchiveSources,
  type TileSourceDecision,
} from "./layer-source";
import { MAP_TILE_ARCHIVE_FORMAT, type TileSummaryRow } from "./tile-archive-state";

const PG_ID = "a4882d70-0000-4000-8000-000000000001";

function dataset(overrides: Partial<TileSummaryRow> = {}): TileSummaryRow {
  return {
    featureCount: 10,
    geometryType: "Point",
    id: PG_ID,
    isGeospatial: true,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: null,
    mapTileCacheVersion: 0,
    ...overrides,
  };
}

describe("splitDatasetIdsByDecision", () => {
  const VECTOR: TileSourceDecision = { kind: "vector", url: "pmtiles://x" },
    ROWS: TileSourceDecision = { kind: "rows" },
    decisions = new Map<string, TileSourceDecision>([
      ["tiled", VECTOR],
      ["rowish", ROWS],
    ]);

  it("files component ids under the path their decision names", () => {
    const split = splitDatasetIdsByDecision(["tiled", "rowish"], decisions);
    expect(split.tileSources).toStrictEqual([{ datasetId: "tiled", url: "pmtiles://x" }]);
    expect(split.rowDatasetIds).toStrictEqual(["rowish"]);
    expect(split.sourcesPending).toBe(false);
  });

  it("flags a pending decision instead of picking either path", () => {
    const withPending = new Map<string, TileSourceDecision>([
      ["tiled", VECTOR],
      ["pending", { kind: "pending" }],
    ]);
    const split = splitDatasetIdsByDecision(["tiled", "pending"], withPending);
    expect(split.sourcesPending).toBe(true);
    expect(split.rowDatasetIds).toStrictEqual([]);
    expect(split.tileSources).toHaveLength(1);
  });

  it("still drops a component id without a decision (a non-geospatial dataset)", () => {
    const split = splitDatasetIdsByDecision(["rowish", "standard"], decisions);
    expect(split.rowDatasetIds).toStrictEqual(["rowish"]);
  });
});

describe("selectLayerSource", () => {
  const large = dataset({
    featureCount: TILE_WAIT_MIN_FEATURES,
    mapTileCacheVersion: 3,
  });

  it("rows for standard datasets and geometry-less geospatial rows", () => {
    expect(selectLayerSource(dataset({ isGeospatial: false }), undefined)).toStrictEqual({
      kind: "rows",
    });
    expect(selectLayerSource(dataset({ geometryType: null }), undefined)).toStrictEqual({
      kind: "rows",
    });
  });

  it("holds pending for a large dataset with no archive yet (#185)", () => {
    expect(selectLayerSource(large, undefined)).toStrictEqual({ kind: "pending" });
  });

  it("keeps rows for small datasets, stale-but-built archives and unwritten datasets", () => {
    expect(
      selectLayerSource({ ...large, featureCount: TILE_WAIT_MIN_FEATURES - 1 }, undefined),
    ).toStrictEqual({ kind: "rows" });
    expect(
      selectLayerSource(
        { ...large, mapTileArchiveBuiltVersion: 2, mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT },
        undefined,
      ),
    ).toStrictEqual({ kind: "rows" });
    expect(selectLayerSource({ ...large, mapTileCacheVersion: 0 }, undefined)).toStrictEqual({
      kind: "rows",
    });
  });

  it("falls back to rows after a failed build", () => {
    expect(selectLayerSource(large, undefined, true)).toStrictEqual({ kind: "rows" });
  });

  it("falls back to rows once the build was skipped as below-threshold", () => {
    const id = "a4882d70-0000-4000-8000-0000000000aa";
    rememberBelowThresholdSkip(id, 3);
    expect(selectLayerSource({ ...large, id }, undefined)).toStrictEqual({ kind: "rows" });
  });

  it("a fresh archive holds pending until its signed URL lands, then goes vector", () => {
    const fresh = {
      ...large,
      mapTileArchiveBuiltVersion: 3,
      mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
    };
    // Metas still loading — withhold the row fetch rather than guess.
    expect(selectLayerSource(fresh, undefined)).toStrictEqual({ kind: "pending" });
    // Loaded and nothing servable — rows.
    expect(selectLayerSource(fresh, null)).toStrictEqual({ kind: "rows" });
    expect(
      selectLayerSource(fresh, { datasetId: PG_ID, url: "https://signed.test/a", version: 3 }),
    ).toStrictEqual({ kind: "vector", url: "pmtiles://https://signed.test/a" });
  });

  it("the #125 format gate reads rows even when the built version matches", () => {
    expect(
      selectLayerSource({ ...large, mapTileArchiveBuiltVersion: 3, mapTileArchiveFormat: 1 }, null),
    ).toStrictEqual({ kind: "rows" });
  });
});

describe("useTileArchiveSources", () => {
  it("keys decisions by dataset id, fresh+signed as vector", () => {
    mocks.metas = new globalThis.Map([
      [PG_ID, { datasetId: PG_ID, url: "https://signed.test/pg", version: 3 }],
    ]);
    const { result } = renderHook(() =>
      useTileArchiveSources([
        dataset({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 3,
        }),
        dataset({
          id: "a4882d70-0000-4000-8000-000000000002",
          mapTileCacheVersion: 3,
        }),
      ]),
    );
    const decisions = result.current;
    expect(decisions.get(PG_ID)).toStrictEqual({
      kind: "vector",
      url: "pmtiles://https://signed.test/pg",
    });
    // Second PG dataset: never built, small → rows.
    expect(decisions.get("a4882d70-0000-4000-8000-000000000002")).toStrictEqual({ kind: "rows" });
    mocks.metas = undefined;
  });

  it("a PG dataset whose metas are still loading holds pending while fresh", () => {
    mocks.metas = undefined;
    const { result } = renderHook(() =>
      useTileArchiveSources([
        dataset({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 3,
        }),
      ]),
    );
    expect(result.current.get(PG_ID)).toStrictEqual({ kind: "pending" });
  });

  it("a PG dataset with no servable archive reads rows once metas are loaded", () => {
    mocks.metas = new globalThis.Map();
    const { result } = renderHook(() =>
      useTileArchiveSources([
        dataset({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 3,
        }),
      ]),
    );
    expect(result.current.get(PG_ID)).toStrictEqual({ kind: "rows" });
    mocks.metas = undefined;
  });
});

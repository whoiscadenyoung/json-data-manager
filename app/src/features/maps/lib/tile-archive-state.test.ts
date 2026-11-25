// @vitest-environment jsdom
import { rememberBelowThresholdSkip } from "@caden/maps/build-scheduler";
import { describe, expect, it, vi } from "vitest";

// The module's import chain reaches `#/env` through the store client (which
// validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import of the module.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { stubSupabase } from "#/lib/store/test-support";

import {
  isFreshArchiveCandidate,
  isTileArchiveStale,
  isTileCandidate,
  MAP_TILE_ARCHIVE_FORMAT,
  tileArchiveMetasOf,
  tileArchiveUploadPath,
  type TileSummaryRow,
} from "./tile-archive-state";

function summary(overrides: Partial<TileSummaryRow> = {}): TileSummaryRow {
  return {
    featureCount: 10,
    geometryType: "Point",
    id: "a4882d70-0000-4000-8000-000000000001",
    isGeospatial: true,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: null,
    mapTileCacheVersion: 0,
    ...overrides,
  };
}

describe("isTileCandidate", () => {
  it("accepts geospatial rows with a geometry type", () => {
    expect(isTileCandidate(summary())).toBe(true);
  });

  it("declines standard datasets and geometry-less geospatial rows", () => {
    expect(isTileCandidate(summary({ isGeospatial: false }))).toBe(false);
    expect(isTileCandidate(summary({ geometryType: null }))).toBe(false);
  });
});

describe("isTileArchiveStale — the scheduler's tested order, fed the raw format column", () => {
  it("never-written datasets are not stale (version 0)", () => {
    expect(isTileArchiveStale(summary())).toBe(false);
  });

  it("a first build is owed when a write happened but nothing ever installed", () => {
    expect(isTileArchiveStale(summary({ mapTileCacheVersion: 3 }))).toBe(true);
  });

  it("the #125 format gate rejects a wrong-format archive even at the current version", () => {
    expect(
      isTileArchiveStale(
        summary({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT - 1,
          mapTileCacheVersion: 3,
        }),
      ),
    ).toBe(true);
  });

  it("an archive built behind the live version is stale-on-view", () => {
    expect(
      isTileArchiveStale(
        summary({
          mapTileArchiveBuiltVersion: 2,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 3,
        }),
      ),
    ).toBe(true);
  });

  it("a current-format archive at the live version is current", () => {
    expect(
      isTileArchiveStale(
        summary({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 3,
        }),
      ),
    ).toBe(false);
  });

  it("the below-threshold skip memo absorbs a would-be first build at that version", () => {
    const id = "a4882d70-0000-4000-8000-0000000000f1";
    rememberBelowThresholdSkip(id, 3);
    expect(isTileArchiveStale(summary({ id, mapTileCacheVersion: 3 }))).toBe(false);
  });
});

describe("isFreshArchiveCandidate — servable-tiles precondition", () => {
  it("requires built at the live version in the current format", () => {
    expect(
      isFreshArchiveCandidate(
        summary({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 3,
        }),
      ),
    ).toBe(true);
    expect(
      isFreshArchiveCandidate(
        summary({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileCacheVersion: 4,
        }),
      ),
    ).toBe(false);
    expect(
      isFreshArchiveCandidate(
        summary({
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: 1,
          mapTileCacheVersion: 3,
        }),
      ),
    ).toBe(false);
    expect(isFreshArchiveCandidate(summary())).toBe(false);
  });
});

describe("tileArchiveUploadPath", () => {
  it("names the dataset and version, and is unique per attempt", () => {
    const first = tileArchiveUploadPath("a4882d70-0000-4000-8000-000000000002", 4);
    const second = tileArchiveUploadPath("a4882d70-0000-4000-8000-000000000002", 4);
    expect(first.startsWith("a4882d70-0000-4000-8000-000000000002/v4-")).toBe(true);
    expect(first.endsWith(".pmtiles")).toBe(true);
    expect(second).not.toBe(first);
  });
});

describe("tileArchiveMetasOf — the signed-URL feed (the metas analogue)", () => {
  it("answers nothing for an empty id list without issuing a query", async () => {
    const { client, queries } = stubSupabase();
    expect(await tileArchiveMetasOf([], { supabase: client })).toStrictEqual([]);
    expect(queries).toStrictEqual([]);
  });

  it("signs current-format, version-matched pointers with the 24 h TTL", async () => {
    const { client, queries, signedUrls } = stubSupabase(() => ({
      data: [
        {
          id: "a4882d70-0000-4000-8000-000000000003",
          mapTileArchiveBuiltVersion: 5,
          mapTileArchiveBytes: 22_000_000,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileArchivePath: "a4882d70-0000-4000-8000-000000000003/v5-x.pmtiles",
          mapTileCacheVersion: 5,
        },
      ],
      error: null,
    }));
    const metas = await tileArchiveMetasOf(["a4882d70-0000-4000-8000-000000000003"], {
      supabase: client,
    });
    expect(metas).toStrictEqual([
      {
        datasetId: "a4882d70-0000-4000-8000-000000000003",
        url: "https://signed.test/tile-archives/a4882d70-0000-4000-8000-000000000003/v5-x.pmtiles",
        version: 5,
      },
    ]);
    expect(signedUrls[0]).toStrictEqual({
      bucket: "tile-archives",
      path: "a4882d70-0000-4000-8000-000000000003/v5-x.pmtiles",
      ttlSeconds: 86_400,
    });
    expect(queries).toHaveLength(1);
  });

  it("omits stale, wrong-format, and path-less pointers without signing them", async () => {
    const { client, signedUrls } = stubSupabase(() => ({
      data: [
        {
          id: "a4882d70-0000-4000-8000-00000000000a",
          mapTileArchiveBuiltVersion: 2,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileArchivePath: "a/p1.pmtiles",
          mapTileCacheVersion: 3,
        },
        {
          id: "a4882d70-0000-4000-8000-00000000000b",
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: 1,
          mapTileArchivePath: "b/p2.pmtiles",
          mapTileCacheVersion: 3,
        },
        {
          id: "a4882d70-0000-4000-8000-00000000000c",
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
          mapTileArchivePath: null,
          mapTileCacheVersion: 3,
        },
      ],
      error: null,
    }));
    const ids = [
      "a4882d70-0000-4000-8000-00000000000a",
      "a4882d70-0000-4000-8000-00000000000b",
      "a4882d70-0000-4000-8000-00000000000c",
    ];
    expect(await tileArchiveMetasOf(ids, { supabase: client })).toStrictEqual([]);
    expect(signedUrls).toStrictEqual([]);
  });

  it("a signing failure drops just that dataset instead of failing the feed", async () => {
    const { client } = stubSupabase(
      () => ({
        data: [
          {
            id: "a4882d70-0000-4000-8000-00000000000d",
            mapTileArchiveBuiltVersion: 1,
            mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
            mapTileArchivePath: "d/p3.pmtiles",
            mapTileCacheVersion: 1,
          },
          {
            id: "a4882d70-0000-4000-8000-00000000000e",
            mapTileArchiveBuiltVersion: 1,
            mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
            mapTileArchivePath: "e/p4.pmtiles",
            mapTileCacheVersion: 1,
          },
        ],
        error: null,
      }),
      { signedUrlPaths: ["d/p3.pmtiles"] },
    );
    const metas = await tileArchiveMetasOf(
      ["a4882d70-0000-4000-8000-00000000000d", "a4882d70-0000-4000-8000-00000000000e"],
      { supabase: client },
    );
    expect(metas).toHaveLength(1);
    const first = metas[0];
    expect(first === undefined ? undefined : first.datasetId).toBe(
      "a4882d70-0000-4000-8000-00000000000e",
    );
  });
});

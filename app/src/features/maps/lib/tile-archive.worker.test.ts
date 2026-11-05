// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The tile worker's geometry-fetch pool contract (issue #134's PG mirror):
 * at most {@link GEOMETRY_FETCH_POOL_SIZE} payload fetches are ever in
 * flight — verified here against a mocked global fetch that counts
 * concurrency — across pages, with byte-exact payload accounting.
 */
import { fetchAllPgGeometryFeatures } from "./tile-archive.worker";

vi.mock("#/env", () => ({
  env: {
    VITE_SUPABASE_ANON_KEY: "test-anon-key",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  },
}));

const GEOMETRY_JSON = JSON.stringify({ type: "Point", coordinates: [1, 2] });

type FakeFetchResponse = { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> };

function stubFetch() {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn<() => Promise<FakeFetchResponse>>(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Hold each fetch a tick so overlapping fetches actually coexist.
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return {
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(GEOMETRY_JSON).buffer,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, maxInFlight: () => maxInFlight };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

import { queryAt, stubSupabase } from "#/lib/store/test-support";

const PG_ID = "a4882d70-0000-4000-8000-000000000001";

function pgRpcRow(entryId: string, overrides: Record<string, unknown> = {}) {
  return {
    bbox: [1, 2, 3, 4],
    data: { name: `Row ${entryId}` },
    entry_id: entryId,
    geometry: { coordinates: [1, 2], type: "Point" },
    geometry_source_path: null,
    geometry_type: "Point",
    next_cursor: null,
    ...overrides,
  };
}

describe("worker PG geometry fetch pool + exhaustion loop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pages dataset_rows_for_tiles to exhaustion, pooling storage-backed fetches", async () => {
    // Page 1: 25 OVERSIZED rows (signed-URL fetches — enough to oversubscribe
    // the pool, so the bound is what limits concurrency). Page 2: one inline
    // jsonb row (parses locally, zero fetches) and one more oversized row.
    const { client, queries, signedUrls } = stubSupabase((query) => {
      if (query.rpc === "dataset_rows_for_tiles" && query.rpcArgs.p_cursor === null) {
        return {
          data: Array.from({ length: 25 }, (_, i) =>
            pgRpcRow(`pg-${i}`, {
              geometry: null,
              geometry_source_path: `${PG_ID}/row-${i}.json`,
              next_cursor: "cursor-2",
            }),
          ),
          error: null,
        };
      }
      return {
        data: [
          pgRpcRow("pg-inline", {
            geometry: { coordinates: [1, 2], type: "Point" },
            next_cursor: null,
          }),
          pgRpcRow("pg-stored", {
            geometry: null,
            geometry_source_path: `${PG_ID}/row-25.json`,
            next_cursor: null,
          }),
        ],
        error: null,
      };
    });
    const { fetchMock, maxInFlight } = stubFetch();

    const { features, payloadBytes } = await fetchAllPgGeometryFeatures(client, PG_ID);

    // The exhaustion loop: page 1 (25 rows, continuation) then page 2 (which
    // exhausts) — exactly two RPC round trips, the second resuming from the
    // first page's last-row cursor.
    expect(queries).toHaveLength(2);
    expect(queryAt(queries, 0).rpcArgs.p_cursor).toBeNull();
    expect(queryAt(queries, 1).rpcArgs.p_cursor).toBe("cursor-2");

    // Every oversized row signed its payload URL through the geometries
    // bucket seam; the inline jsonb row parsed locally (26 fetches, not 27).
    expect(fetchMock).toHaveBeenCalledTimes(26);
    expect(signedUrls).toHaveLength(26);
    expect(signedUrls[0]).toStrictEqual({
      bucket: "geometries",
      path: `${PG_ID}/row-0.json`,
      ttlSeconds: 3600,
    });
    // The bound is the worker's GEOMETRY_FETCH_POOL_SIZE (12); and the test
    // is not vacuous — the 26 fetches genuinely overlapped.
    expect(maxInFlight()).toBeLessThanOrEqual(12);
    expect(maxInFlight()).toBeGreaterThan(1);

    expect(features).toHaveLength(27);
    const first = features.at(0);
    const last = features.at(26);
    expect(first === undefined ? undefined : first._id).toBe("pg-0");
    expect(last === undefined ? undefined : last._id).toBe("pg-stored");
    // Byte-exact accounting across both pages: oversized rows counted off
    // the wire, the inline row's JSON-encoded bytes stringified locally.
    const wireBytes = new TextEncoder().encode(GEOMETRY_JSON).byteLength;
    const inlineBytes = new TextEncoder().encode(
      JSON.stringify({ coordinates: [1, 2], type: "Point" }),
    ).byteLength;
    expect(payloadBytes).toBe(26 * wireBytes + inlineBytes);
  });

  it("an exhausted single page with no rows completes empty", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    const { features, payloadBytes } = await fetchAllPgGeometryFeatures(client, PG_ID);
    // One round trip: an empty page is exhausted by definition.
    expect(queries).toHaveLength(1);
    expect(features).toStrictEqual([]);
    expect(payloadBytes).toBe(0);
  });

  it("rejects when a storage-backed payload fetch fails, failing the build", async () => {
    const { client } = stubSupabase(() => ({
      data: [
        pgRpcRow("pg-stored", {
          geometry: null,
          geometry_source_path: `${PG_ID}/row-1.json`,
        }),
      ],
      error: null,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<FakeFetchResponse>>(async () => ({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    await expect(fetchAllPgGeometryFeatures(client, PG_ID)).rejects.toThrow(
      /Geometry payload fetch failed with HTTP/,
    );
  });
});

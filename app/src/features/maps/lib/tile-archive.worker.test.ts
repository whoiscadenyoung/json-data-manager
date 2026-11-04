import type { ConvexClient } from "convex/browser";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The tile worker's geometry-fetch pool contract (issue #134): at most
 * {@link GEOMETRY_FETCH_POOL_SIZE} payload fetches are ever in flight —
 * verified here against a mocked global fetch that counts concurrency —
 * across pages, with byte-exact payload accounting.
 */
import { fetchAllGeometryFeatures } from "./tile-archive.worker";

vi.mock("#/env", () => ({
  env: {
    VITE_CONVEX_URL: "http://127.0.0.1:3212",
    VITE_SUPABASE_ANON_KEY: "test-anon-key",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  },
}));

interface FakeGeometryRow {
  entryId: string;
  geometryJson?: string;
  geometryUrl?: string;
}

const { geometryPages, setGeometryPages, setPageGapMs, pageGapMs } = vi.hoisted(() => {
  let pages: Array<Array<FakeGeometryRow>> = [];
  let pageGap = 0;
  return {
    geometryPages: (): Array<Array<FakeGeometryRow>> => pages,
    setGeometryPages: (next: Array<Array<FakeGeometryRow>>): void => {
      pages = next;
    },
    setPageGapMs: (ms: number): void => {
      pageGap = ms;
    },
    pageGapMs: (): number => pageGap,
  };
});

vi.mock("#/lib/dataset-rows", () => ({
  forEachDatasetGeometryPage: async (
    _schemaId: string,
    onPage: (rows: Array<FakeGeometryRow>) => void,
  ): Promise<void> => {
    for (const page of geometryPages()) {
      onPage(page);
      const gap = pageGapMs();
      // oxlint-disable-next-line no-await-in-loop -- the inter-page gap IS the condition under test: it lets the pool drain mid-build.
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    }
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

function urlRow(i: number): FakeGeometryRow {
  return { entryId: `e${i}`, geometryUrl: `https://storage.test/geo/${i}` };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setPageGapMs(0);
});

describe("worker geometry fetch pool", () => {
  it("never exceeds the pool bound with fetches in flight", async () => {
    // 40 rows over two pages: more rows than the pool size, so the bound is
    // what limits concurrency, and two pages so the bound holds across the
    // sequential page loop too.
    setGeometryPages([
      Array.from({ length: 25 }, (_, i) => urlRow(i)),
      Array.from({ length: 15 }, (_, i) => urlRow(25 + i)),
    ]);
    const { fetchMock, maxInFlight } = stubFetch();

    const { features, payloadBytes } = await fetchAllGeometryFeatures(
      {} as ConvexClient,
      "schema1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(40);
    // The bound is the worker's GEOMETRY_FETCH_POOL_SIZE (12); a serial
    // regression would make this assert vacuous, hence the next line.
    expect(maxInFlight()).toBeLessThanOrEqual(12);
    expect(maxInFlight()).toBeGreaterThan(1);

    expect(features).toHaveLength(40);
    const first = features.at(0);
    const last = features.at(39);
    expect(first === undefined ? undefined : first._id).toBe("e0");
    expect(last === undefined ? undefined : last._id).toBe("e39");
    // Byte-exact accounting: 40 payloads × their UTF-8 byte length (the old
    // `text.length` accounting counted code units instead).
    expect(payloadBytes).toBe(40 * new TextEncoder().encode(GEOMETRY_JSON).byteLength);
  });

  it("counts inline geometryJson rows toward the payload without fetching", async () => {
    setGeometryPages([
      [
        { entryId: "inline", geometryJson: GEOMETRY_JSON },
        { entryId: "fetched", geometryUrl: "https://storage.test/geo/1" },
        { entryId: "empty", geometryUrl: undefined }, // no geometry at all
      ],
    ]);
    const { fetchMock } = stubFetch();

    const { features, payloadBytes } = await fetchAllGeometryFeatures(
      {} as ConvexClient,
      "schema1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the url row
    expect(features).toHaveLength(2);
    expect(payloadBytes).toBe(2 * new TextEncoder().encode(GEOMETRY_JSON).byteLength);
  });

  it("completes when the pool fully drains between pages (wave gap)", async () => {
    // Production paginates with a convex.query round trip between pages
    // (dataset-rows.ts), so the pool's task queue can empty mid-build before
    // the next page's rows are submitted. Page 1 here oversubscribes the pool
    // and fully drains during the real-timer page gap; page 2's inline rows
    // resolve in microtasks. Regression for the BoundedPool handoff leak:
    // the old pool finished the wave with #active at the bound and no tasks
    // running, so page 2 queued forever and the build never settled.
    setGeometryPages([
      Array.from({ length: 25 }, (_, i) => urlRow(i)),
      Array.from({ length: 5 }, (_, i) => ({
        entryId: `inline${i}`,
        geometryJson: GEOMETRY_JSON,
      })),
    ]);
    // Longer than the 2 ms fetch hold, so page 1 is fully drained before
    // page 2 is queued.
    setPageGapMs(50);
    const { fetchMock } = stubFetch();

    const { features, payloadBytes } = await fetchAllGeometryFeatures(
      {} as ConvexClient,
      "schema1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(features).toHaveLength(30);
    expect(payloadBytes).toBe(30 * new TextEncoder().encode(GEOMETRY_JSON).byteLength);
  });

  it("rejects when a payload fetch fails, failing the build", async () => {
    setGeometryPages([[urlRow(0), urlRow(1)]]);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<FakeFetchResponse>>(async () => ({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    await expect(fetchAllGeometryFeatures({} as ConvexClient, "schema1")).rejects.toThrow(
      /Geometry payload fetch failed with HTTP/,
    );
  });
});

// ---------------------------------------------------------------------------
// The Postgres build path (stage 2, issue #201): the SAME pool contract over
// the PG feed, driven through the REAL seam (`forEachDatasetGeometryPage` →
// store `rowsForTiles` → the `dataset_rows_for_tiles` RPC shape) against a
// stubbed supabase client — which is also the end-to-end verification of the
// keyset exhaustion loop (`next_cursor` read off the last row, null = done).
// ---------------------------------------------------------------------------

import { queryAt, stubSupabase } from "#/lib/store/test-support";

import { fetchAllPgGeometryFeatures } from "./tile-archive.worker";

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

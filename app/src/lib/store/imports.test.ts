// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  chunkRowsForRpc,
  complete,
  IMPORT_CHUNK_MAX_BYTES,
  IMPORT_CHUNK_MAX_ROWS,
  importChunk,
  fail,
  getQueryOptions,
  listForDatasetQueryOptions,
  start,
} from "./imports";
import {
  argsOf,
  firstArg,
  methodList,
  postgrestError,
  queryAt,
  runQueryOptions,
  stubSupabase,
} from "./test-support";

/** The `index`th chunk's row count, or a loud failure (the no-optional-chaining test style). */
function chunkRowCount(chunks: ReadonlyArray<ReadonlyArray<unknown>>, index: number): number {
  const chunk = chunks[index];
  if (chunk === undefined) {
    throw new Error(`No chunk at index ${index} (have ${chunks.length}).`);
  }
  return chunk.length;
}

describe("imports.chunkRowsForRpc — the §10 chunker", () => {
  it("splits by the ~1.5 MB byte budget (the design's 1–2 MB HTTP-shaped band)", () => {
    // One ~800 KB row: two together (≈1.6 MB serialized) exceed 1.5 MB, so
    // every row lands in its own chunk.
    const big = "x".repeat(800_000),
      rows = [{ data: { blob: big } }, { data: { blob: big } }, { data: { blob: big } }];
    const chunks = chunkRowsForRpc(rows);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(1);
    }
  });

  it("packs small rows up to the row-count cap (500, the Convex chunker's HTTP-shape guard)", () => {
    const rows = Array.from({ length: IMPORT_CHUNK_MAX_ROWS + 120 }, (_, index) => ({
      data: { n: index },
    }));
    const chunks = chunkRowsForRpc(rows);
    expect(chunks.length).toBe(2);
    expect(chunkRowCount(chunks, 0)).toBe(IMPORT_CHUNK_MAX_ROWS);
    expect(chunkRowCount(chunks, 1)).toBe(120);
  });

  it("never splits a single row even when it alone exceeds the budget", () => {
    const rows = [{ data: { blob: "x".repeat(IMPORT_CHUNK_MAX_BYTES + 1) } }];
    const chunks = chunkRowsForRpc(rows);
    expect(chunks.length).toBe(1);
    expect(chunkRowCount(chunks, 0)).toBe(1);
  });

  it("answers an empty row list with no chunks (the caller skips the loop)", () => {
    expect(chunkRowsForRpc([])).toStrictEqual([]);
  });

  it("honors explicit overrides (a caller pinning a smaller band for tests)", () => {
    const rows = [{ data: { a: 1 } }, { data: { a: 2 } }, { data: { a: 3 } }];
    expect(chunkRowsForRpc(rows, { maxRows: 2 })).toHaveLength(2);
  });
});

describe("imports — one history row per attempt (§3.2 / §5.3)", () => {
  it("start inserts the pending row with the declared total and answers its id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "imp-1" }, error: null }));
    const id = await start({ datasetId: "d1", total: 42 }, { supabase: client });
    expect(id).toBe("imp-1");
    const first = queryAt(queries, 0);
    expect(first.table).toBe("imports");
    expect(firstArg(first, "insert")).toStrictEqual({ dataset_id: "d1", total: 42 });
    expect(methodList(first)).toStrictEqual(["insert", "select", "single"]);
  });

  it("importChunk calls the import_entries RPC with the dataset and rows, and answers the count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: 7, error: null }));
    const rows = [{ data: { a: 1 } }, { data: { a: 2 } }];
    const inserted = await importChunk({ datasetId: "d1", rows }, { supabase: client });
    expect(inserted).toBe(7);
    const first = queryAt(queries, 0);
    expect(first.rpc).toBe("import_entries");
    expect(first.rpcArgs).toStrictEqual({ p_dataset: "d1", p_rows: rows });
  });

  it("importChunk rejects a non-numeric RPC answer instead of reporting fake progress", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: null }));
    await expect(
      importChunk({ datasetId: "d1", rows: [{ data: {} }] }, { supabase: client }),
    ).rejects.toThrowError("import_entries returned no count.");
  });

  it("complete and fail close the row by id with the right status patch", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [{ id: "imp-1" }],
      error: null,
    }));
    await complete({ importId: "imp-1" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ status: "completed" });
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["id", "imp-1"]);

    await fail({ error: "chunk 3 exploded", importId: "imp-1" }, { supabase: client });
    expect(firstArg(queryAt(queries, 1), "update")).toStrictEqual({
      error: "chunk 3 exploded",
      status: "failed",
    });
  });

  it("surfaces RLS denials on the writes (a locked dataset's imports row is not writable)", async () => {
    const { client } = stubSupabase(() => ({
      data: null,
      error: postgrestError("new row violates row-level security policy"),
    }));
    await expect(start({ datasetId: "d1", total: 1 }, { supabase: client })).rejects.toThrowError(
      "new row violates row-level security policy (42501)",
    );
  });
});

describe("imports reads — queryOptions carry the args in the key", () => {
  it("get and listForDataset key by their args", () => {
    const { client } = stubSupabase();
    expect(getQueryOptions({ importId: "imp-1" }, { supabase: client }).queryKey).toStrictEqual([
      "pg:imports",
      "get",
      { importId: "imp-1" },
    ]);
    expect(
      listForDatasetQueryOptions({ datasetId: "d1" }, { supabase: client }).queryKey,
    ).toStrictEqual(["pg:imports", "listForDataset", { datasetId: "d1" }]);
  });

  it("get resolves the row or null", async () => {
    const { client, respond } = stubSupabase();
    respond(() => ({
      data: {
        createdAt: "2026-11-03T00:00:00+00:00",
        datasetId: "d1",
        error: null,
        id: "imp-1",
        processed: 3,
        skipped: 0,
        status: "processing",
        total: 10,
        updatedAt: "2026-11-03T00:00:01+00:00",
      },
      error: null,
    }));
    await expect(
      runQueryOptions(getQueryOptions({ importId: "imp-1" }, { supabase: client })),
    ).resolves.toStrictEqual({
      createdAt: "2026-11-03T00:00:00+00:00",
      datasetId: "d1",
      error: null,
      id: "imp-1",
      processed: 3,
      skipped: 0,
      status: "processing",
      total: 10,
      updatedAt: "2026-11-03T00:00:01+00:00",
    });
    respond(() => ({ data: null, error: null }));
    await expect(
      runQueryOptions(getQueryOptions({ importId: "imp-2" }, { supabase: client })),
    ).resolves.toBe(null);
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  create,
  createGeometrySourceUrl,
  DEFAULT_GEOMETRY_ROWS_LIMIT,
  getByEntry,
  list,
  remove,
  replace,
  rowsForTiles,
  rowsForTilesQueryOptions,
} from "./geometries";
import {
  allArgs,
  argsOf,
  firstArg,
  methodList,
  postgrestError,
  queryAt,
  stubSupabase,
} from "./test-support";

function rpcRow(entryId: string, overrides: Record<string, unknown> = {}) {
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

describe("geometries.rowsForTiles — the dataset_rows_for_tiles RPC (§5.5)", () => {
  it("pages via the RPC and maps the wire rows to consumer shape", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        rpcRow("e1"),
        rpcRow("e2", {
          geometry: null,
          geometry_source_path: "d1/e2.json",
          next_cursor: "cursor-2",
        }),
      ],
      error: null,
    }));
    const page = await rowsForTiles({ datasetId: "d1" }, { supabase: client });
    const first = queryAt(queries, 0);
    expect(first.rpc).toBe("dataset_rows_for_tiles");
    expect(first.rpcArgs).toStrictEqual({
      p_cursor: null,
      p_dataset: "d1",
      p_limit: DEFAULT_GEOMETRY_ROWS_LIMIT,
    });
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.rows[0]).toStrictEqual({
      bbox: [1, 2, 3, 4],
      data: { name: "Row e1" },
      datasetId: "d1",
      entryId: "e1",
      geometry: { coordinates: [1, 2], type: "Point" },
      sourcePath: null,
      type: "Point",
    });
    expect(page.rows[1]).toMatchObject({ entryId: "e2", sourcePath: "d1/e2.json", geometry: null });
  });

  it("forwards the caller's cursor and limit, and null next_cursor is exhausted", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    const page = await rowsForTiles(
      { cursor: "cursor-2", datasetId: "d1", limit: 10 },
      { supabase: client },
    );
    expect(queryAt(queries, 0).rpcArgs).toStrictEqual({
      p_cursor: "cursor-2",
      p_dataset: "d1",
      p_limit: 10,
    });
    expect(page).toStrictEqual({ nextCursor: null, rows: [] });
  });

  it("list is the same feed under the api.cms.geometries.list name", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [rpcRow("e1")], error: null }));
    const page = await list({ datasetId: "d1" }, { supabase: client });
    expect(queryAt(queries, 0).rpc).toBe("dataset_rows_for_tiles");
    expect(page.rows.map((row) => row.entryId)).toStrictEqual(["e1"]);
  });

  it("queryOptions carry the args in the key", () => {
    const { client } = stubSupabase();
    const args = { cursor: null, datasetId: "d1" };
    expect(rowsForTilesQueryOptions(args, { supabase: client }).queryKey).toStrictEqual([
      "pg:geometries",
      "rowsForTiles",
      args,
    ]);
  });
});

describe("geometries.getByEntry", () => {
  it("answers the entry's single geometry row, or null when it has none", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      expect(query.table).toBe("geometries");
      return {
        data: [
          {
            bbox: [1, 2, 3, 4],
            datasetId: "d1",
            entryId: "e1",
            geometry: { coordinates: [1, 2], type: "Point" },
            sourcePath: null,
            type: "Point",
          },
        ],
        error: null,
      };
    });
    const row = await getByEntry({ entryId: "e1" }, { supabase: client });
    expect(row).toMatchObject({ entryId: "e1", type: "Point" });
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["entry_id", "e1"]);
    respond(() => ({ data: null, error: null }));
    await expect(getByEntry({ entryId: "e2" }, { supabase: client })).resolves.toBe(null);
  });
});

describe("geometries writes", () => {
  it("create (inline) inserts the verbatim source and lets the trigger derive the envelope", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: { bbox: null, entry_id: "e1" },
      error: null,
    }));
    await create(
      {
        datasetId: "d1",
        entryId: "e1",
        geometry: { coordinates: [1, 2], type: "Point" },
      },
      { supabase: client },
    );
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({
      dataset_id: "d1",
      entry_id: "e1",
      source: { coordinates: [1, 2], type: "Point" },
      type: "Point",
    });
  });

  it("create (storage-backed) requires type + bbox and writes source_path instead of source", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { entry_id: "e1" }, error: null }));
    await create(
      {
        bbox: [1, 2, 3, 4],
        datasetId: "d1",
        entryId: "e1",
        sourcePath: "d1/e1.json",
        type: "Polygon",
      },
      { supabase: client },
    );
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({
      bbox: [1, 2, 3, 4],
      dataset_id: "d1",
      entry_id: "e1",
      source_path: "d1/e1.json",
      type: "Polygon",
    });
    await expect(
      create({ datasetId: "d1", entryId: "e1", sourcePath: "d1/e1.json" }, { supabase: client }),
    ).rejects.toThrowError("Storage-backed geometry rows must carry their `type`");
    await expect(
      create(
        { datasetId: "d1", entryId: "e1", sourcePath: "d1/e1.json", type: "Polygon" },
        { supabase: client },
      ),
    ).rejects.toThrowError("client-supplied `bbox`");
  });

  it("rejects ambiguous source shapes and geometry payloads without a type", async () => {
    const { client, queries } = stubSupabase();
    await expect(
      create(
        {
          datasetId: "d1",
          entryId: "e1",
          geometry: { type: "Point" },
          sourcePath: "d1/e1.json",
        },
        { supabase: client },
      ),
    ).rejects.toThrowError("exactly one source");
    await expect(
      create(
        { datasetId: "d1", entryId: "e1", geometry: { coordinates: [1] } },
        { supabase: client },
      ),
    ).rejects.toThrowError("string 'type'");
    expect(queries.length).toBe(0);
  });

  it("replace upserts on entry_id (replace-on-existing and fill-the-gap are one statement)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { entry_id: "e1" }, error: null }));
    await replace(
      { datasetId: "d1", entryId: "e1", geometry: { coordinates: [0, 0], type: "Point" } },
      { supabase: client },
    );
    const first = queryAt(queries, 0);
    expect(methodList(first)[0]).toBe("upsert");
    expect(allArgs(first, "upsert")).toStrictEqual([
      [
        {
          dataset_id: "d1",
          entry_id: "e1",
          source: { coordinates: [0, 0], type: "Point" },
          type: "Point",
        },
        { onConflict: "entry_id" },
      ],
    ]);
  });

  it("remove deletes by entry", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ entry_id: "e1" }], error: null }));
    await remove({ entryId: "e1" }, { supabase: client });
    const first = queryAt(queries, 0);
    expect(methodList(first)[0]).toBe("delete");
    expect(argsOf(first, "eq")).toStrictEqual(["entry_id", "e1"]);
  });

  it("surfaces RLS denials on writes", async () => {
    const { client } = stubSupabase(() => ({
      data: null,
      error: postgrestError("new row violates row-level security policy"),
    }));
    await expect(
      create({ datasetId: "d1", entryId: "e1", geometry: { type: "Point" } }, { supabase: client }),
    ).rejects.toThrowError("new row violates row-level security policy (42501)");
  });
});

describe("createGeometrySourceUrl", () => {
  it("signs the payload path in the geometries bucket", async () => {
    const { client, signedUrls } = stubSupabase();
    const url = await createGeometrySourceUrl(client, "d1/e1.json");
    expect(url).toBe("https://signed.test/geometries/d1/e1.json");
    expect(signedUrls).toStrictEqual([
      { bucket: "geometries", path: "d1/e1.json", ttlSeconds: 3600 },
    ]);
  });
});

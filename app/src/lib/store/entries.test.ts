// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  clearDatasetRows,
  create,
  getQueryOptions,
  listForIds,
  LIST_FOR_IDS_MAX,
  listPage,
  listPageQueryOptions,
  remove,
  searchEntries,
  searchEntriesQueryOptions,
  update,
} from "./entries";
import {
  allArgs,
  argsOf,
  firstArg,
  methodList,
  postgrestError,
  queryAt,
  runQueryOptions,
  stubSupabase,
} from "./test-support";

function entryWire(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-03T00:00:00+00:00",
    data: { name: `Row ${id}` },
    datasetId: "d1",
    geometryType: null,
    id,
    ...overrides,
  };
}

describe("entries.listPage — the PostgREST keyset pager", () => {
  it("pages newest-first by (created_at, id) and probes one row past the page for exhaustion", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [entryWire("e1"), entryWire("e2"), entryWire("e3")],
      error: null,
    }));
    const result = await listPage(
      { cursor: null, datasetId: "d1", numItems: 2 },
      { supabase: client },
    );
    // The probe row is trimmed and becomes the continuation; the page itself
    // is exactly numItems rows.
    expect(result.rows.map((row) => row.id)).toStrictEqual(["e1", "e2"]);
    expect(result.nextCursor).not.toBe(null);
    const first = queryAt(queries, 0);
    expect(methodList(first)).toStrictEqual(["select", "eq", "order", "order", "limit"]);
    expect(firstArg(first, "select")).toBe(
      "id,datasetId:dataset_id,data,geometryType:geometry_type,createdAt:created_at",
    );
    expect(allArgs(first, "order")).toStrictEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(firstArg(first, "limit")).toBe(3);
  });

  it("chains the keyset filter from the cursor: strictly-after (created_at, id), no OFFSET", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [entryWire("e9")], error: null }));
    const cursor = btoa(JSON.stringify(["2026-11-03T00:00:00+00:00", "e2"]));
    const result = await listPage(
      { cursor, datasetId: "d1", numItems: 2, order: "asc" },
      { supabase: client },
    );
    expect(result).toStrictEqual({ nextCursor: null, rows: [entryWire("e9")] });
    const first = queryAt(queries, 0);
    expect(firstArg(first, "or")).toBe(
      "and(created_at.eq.2026-11-03T00:00:00+00:00,id.gt.e2),created_at.gt.2026-11-03T00:00:00+00:00",
    );
    expect(allArgs(first, "order")).toStrictEqual([
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("reports exhaustion after a full page that empties the table (no phantom cursor)", async () => {
    const { client, respond } = stubSupabase();
    // Three rows for a two-row page: the probe row is what proves "more".
    respond(() => ({ data: [entryWire("e1"), entryWire("e2"), entryWire("e3")], error: null }));
    const full = await listPage(
      { cursor: null, datasetId: "d1", numItems: 2 },
      { supabase: client },
    );
    expect(full.rows.length).toBe(2);
    expect(full.nextCursor).not.toBe(null);
    respond(() => ({ data: [], error: null }));
    const next = await listPage(
      { cursor: full.nextCursor, datasetId: "d1", numItems: 2 },
      { supabase: client },
    );
    expect(next).toStrictEqual({ nextCursor: null, rows: [] });
  });

  it("rejects malformed cursors instead of silently re-reading page one", async () => {
    const { client } = stubSupabase();
    await expect(
      listPage({ cursor: "not-a-cursor", datasetId: "d1", numItems: 2 }, { supabase: client }),
    ).rejects.toThrowError("Invalid entries page cursor.");
  });

  it("queryOptions carry the args in the key (the reactive layer keys pages by cursor)", () => {
    const { client } = stubSupabase();
    const args = { cursor: null, datasetId: "d1", numItems: 200 };
    const options = listPageQueryOptions(args, { supabase: client });
    expect(options.queryKey).toStrictEqual(["pg:entries", "listPage", args]);
  });
});

describe("entries.searchEntries — the search_entries RPC (§5.1)", () => {
  it("passes the query/filter/sort args through and reads next_cursor from the last row", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        {
          created_at: "2026-11-03T00:00:00+00:00",
          data: { name: "Row e1" },
          geometry_type: "Point",
          id: "e1",
          next_cursor: "cursor-2",
        },
      ],
      error: null,
    }));
    const result = await searchEntries(
      {
        datasetId: "d1",
        filters: [{ key: "status", op: "eq", value: "open" }],
        query: "grant",
        sort: { dir: "asc", key: "name" },
      },
      { supabase: client },
    );
    const first = queryAt(queries, 0);
    expect(first.rpc).toBe("search_entries");
    expect(first.rpcArgs).toStrictEqual({
      p_cursor: null,
      p_dataset: "d1",
      p_filters: [{ key: "status", op: "eq", value: "open" }],
      p_limit: 200,
      p_query: "grant",
      p_sort: { dir: "asc", key: "name" },
    });
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.rows).toStrictEqual([
      {
        createdAt: "2026-11-03T00:00:00+00:00",
        data: { name: "Row e1" },
        datasetId: "d1",
        geometryType: "Point",
        id: "e1",
      },
    ]);
  });

  it("defaults every optional concern (no search, no filter, RPC-default sort, 200 rows)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    const result = await searchEntries({ datasetId: "d1" }, { supabase: client });
    expect(queryAt(queries, 0).rpcArgs).toStrictEqual({
      p_cursor: null,
      p_dataset: "d1",
      p_filters: null,
      p_limit: 200,
      p_query: null,
      p_sort: null,
    });
    expect(result).toStrictEqual({ nextCursor: null, rows: [] });
  });

  it("queryOptions key carries the full args object", () => {
    const { client } = stubSupabase();
    const args = { datasetId: "d1", query: "x" };
    expect(searchEntriesQueryOptions(args, { supabase: client }).queryKey).toStrictEqual([
      "pg:entries",
      "searchEntries",
      args,
    ]);
  });
});

describe("entries.get / listForIds", () => {
  it("get answers the row or null (RLS-invisible reads as not found)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond(() => ({ data: [entryWire("e1")], error: null }));
    const options = getQueryOptions({ entryId: "e1" }, { supabase: client });
    await expect(runQueryOptions(options)).resolves.toStrictEqual(entryWire("e1"));
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["id", "e1"]);
    respond(() => ({ data: null, error: null }));
    await expect(
      runQueryOptions(getQueryOptions({ entryId: "e2" }, { supabase: client })),
    ).resolves.toBe(null);
  });

  it("listForIds dedupes and caps at 200 ids, like the component read", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [entryWire("e1")], error: null }));
    const rows = await listForIds({ entryIds: ["e1", "e1", "e2"] }, { supabase: client });
    expect(rows.map((row) => row.id)).toStrictEqual(["e1"]);
    expect(argsOf(queryAt(queries, 0), "in")).toStrictEqual(["id", ["e1", "e2"]]);
    const tooMany = Array.from({ length: LIST_FOR_IDS_MAX + 1 }, (_, index) => `e${index}`);
    await expect(listForIds({ entryIds: tooMany }, { supabase: client })).rejects.toThrowError(
      `entryIds exceeds ${LIST_FOR_IDS_MAX} items`,
    );
  });

  it("answers an empty id list without a round trip", async () => {
    const { client, queries } = stubSupabase();
    await expect(listForIds({ entryIds: [] }, { supabase: client })).resolves.toStrictEqual([]);
    expect(queries.length).toBe(0);
  });
});

describe("entries writes", () => {
  it("create inserts the row then the geometry, and returns the new id", async () => {
    // One dispatcher keyed by table — the create path's two statements in order.
    const { client, queries } = stubSupabase((query) =>
      query.table === "entries"
        ? { data: { id: "e-new" }, error: null }
        : { data: { entry_id: "e-new" }, error: null },
    );
    const id = await create(
      {
        data: { name: "New" },
        datasetId: "d1",
        geometry: JSON.stringify({ coordinates: [1, 2], type: "Point" }),
      },
      { supabase: client },
    );
    expect(id).toBe("e-new");
    expect(queries.length).toBe(2);
    expect(queryAt(queries, 0).table).toBe("entries");
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({
      data: { name: "New" },
      dataset_id: "d1",
    });
    expect(queryAt(queries, 1).table).toBe("geometries");
    expect(firstArg(queryAt(queries, 1), "insert")).toStrictEqual({
      dataset_id: "d1",
      entry_id: "e-new",
      source: { coordinates: [1, 2], type: "Point" },
      type: "Point",
    });
  });

  it("create rejects a geometry that is not JSON", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "e-new" }, error: null }));
    await expect(
      create({ data: {}, datasetId: "d1", geometry: "{not json" }, { supabase: client }),
    ).rejects.toThrowError("Geometry is not valid JSON.");
    // The entry itself landed; only the geometry step failed (the module's
    // documented two-statement shape).
    expect(queries.length).toBe(1);
  });

  it("update patches data, leaves geometry untouched by default, clears on null, replaces on text", async () => {
    const { client, queries } = stubSupabase((query) =>
      query.table === "entries"
        ? { data: [{ id: "e1" }], error: null }
        : { data: [{ entry_id: "e1" }], error: null },
    );
    await update({ data: { name: "Edited" }, entryId: "e1" }, { supabase: client });
    expect(queries.length).toBe(1);
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ data: { name: "Edited" } });

    await update({ data: {}, entryId: "e1", geometry: null }, { supabase: client });
    // Every update() call writes the entries row FIRST (queries 0/2/4), then
    // the geometry step when the arg asks for one (queries 1/3... — here
    // only the delete).
    const clearQuery = queryAt(queries, 2);
    expect(clearQuery.table).toBe("geometries");
    expect(methodList(clearQuery)[0]).toBe("delete");

    await update(
      {
        data: {},
        datasetId: "d1",
        entryId: "e1",
        geometry: '{"type":"Point","coordinates":[0,0]}',
      },
      { supabase: client },
    );
    const replaceQuery = queryAt(queries, 4);
    expect(replaceQuery.table).toBe("geometries");
    expect(methodList(replaceQuery)[0]).toBe("upsert");
    expect(allArgs(replaceQuery, "upsert")).toStrictEqual([
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

  it("remove deletes the entry by id; clearDatasetRows deletes the dataset's rows and counts them", async () => {
    const { client, queries, respond } = stubSupabase();
    respond(() => ({ data: [], error: null }));
    await remove({ entryId: "e1" }, { supabase: client });
    expect(queryAt(queries, 0).table).toBe("entries");
    expect(methodList(queryAt(queries, 0))[0]).toBe("delete");

    respond(() => ({ data: [{ id: "e1" }, { id: "e2" }], error: null }));
    await expect(clearDatasetRows({ datasetId: "d1" }, { supabase: client })).resolves.toBe(2);
    expect(argsOf(queryAt(queries, 1), "eq")).toStrictEqual(["dataset_id", "d1"]);
  });

  it("surfaces RLS denials on writes (the locked-dataset shape is the DB's)", async () => {
    const { client } = stubSupabase(() => ({
      data: null,
      error: postgrestError("new row violates row-level security policy"),
    }));
    await expect(create({ data: {}, datasetId: "d1" }, { supabase: client })).rejects.toThrowError(
      "new row violates row-level security policy (42501)",
    );
  });
});

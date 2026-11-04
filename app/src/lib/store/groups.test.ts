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
  getQueryOptions,
  list,
  listQueryOptions,
  remove,
  setCollection,
  setDatasetGroup,
  update,
  DEFAULT_GROUPS_LIMIT,
} from "./groups";
import {
  allArgs,
  argsOf,
  firstArg,
  methodList,
  queryAt,
  runQueryOptions,
  stubSupabase,
} from "./test-support";

/** Pre-aliased (camelCase) — the stub skips PostgREST's `select` aliases. */
function groupRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    collectionId: null,
    createdAt: "2026-11-03T00:00:00+00:00",
    createdBy: "11111111-1111-1111-1111-111111111111",
    description: null,
    id,
    name: `Group ${id}`,
    updatedAt: "2026-11-03T00:00:00+00:00",
    ...overrides,
  };
}

describe("groups.list — every group, or one collection's", () => {
  it("without a collection filter, selects all groups newest-first at the default limit", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [groupRow("g1", { collectionId: "c1" }), groupRow("g2")],
      error: null,
    }));
    const rows = await list({}, { supabase: client });
    expect(rows[0]).toMatchObject({ id: "g1", collectionId: "c1" });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("groups");
    expect(query.operations.some((op) => op.method === "eq")).toBe(false);
    expect(allArgs(query, "order")).toStrictEqual([["created_at", { ascending: false }]]);
    expect(firstArg(query, "limit")).toBe(DEFAULT_GROUPS_LIMIT);
  });

  it("with a collection filter, eqs collection_id (the by_collection index's direction)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await list({ collectionId: "c1", limit: 10 }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(argsOf(query, "eq")).toStrictEqual(["collection_id", "c1"]);
    expect(firstArg(query, "limit")).toBe(10);
  });

  it("keys its query options with the args (the collection-filtered lists cache apart)", () => {
    const { client } = stubSupabase();
    expect(listQueryOptions({ collectionId: "c1" }, { supabase: client }).queryKey).toStrictEqual([
      "pg:groups",
      "list",
      { collectionId: "c1" },
    ]);
    expect(getQueryOptions({ groupId: "g1" }, { supabase: client }).queryKey).toStrictEqual([
      "pg:groups",
      "get",
      { groupId: "g1" },
    ]);
  });
});

describe("groups.get", () => {
  it("returns null on an empty read (the RLS not-found shape)", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: null }));
    await expect(
      runQueryOptions(getQueryOptions({ groupId: "g1" }, { supabase: client })),
    ).resolves.toBe(null);
  });
});

describe("groups.create / update — the component's name rule", () => {
  it("inserts with the given collection link and returns the id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "new-g" }, error: null }));
    const id = await create(
      { collectionId: "c1", description: "2025 polygons", name: "SMART Grant" },
      { supabase: client },
    );
    expect(id).toBe("new-g");
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({
      collection_id: "c1",
      description: "2025 polygons",
      name: "SMART Grant",
    });
  });

  it("omits absent fields (a standalone group inserts without collection_id)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "g" }, error: null }));
    await create({ name: "Standalone" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({ name: "Standalone" });
  });

  it("rejects blank names client-side with the component's message (no query fired)", async () => {
    const { client, queries } = stubSupabase();
    await expect(create({ name: " " }, { supabase: client })).rejects.toThrowError(
      "Group must have a name",
    );
    await expect(update({ groupId: "g1", name: "" }, { supabase: client })).rejects.toThrowError(
      "Group must have a name",
    );
    expect(queries.length).toBe(0);
  });

  it("update patches only the given fields", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "g1" }], error: null }));
    await update({ groupId: "g1", name: "Renamed" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ name: "Renamed" });
  });
});

describe("groups.remove — the cascade delete (datasets ungroup via the FK)", () => {
  it("deletes by id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "g1" }], error: null }));
    await remove({ groupId: "g1" }, { supabase: client });
    expect(methodList(queryAt(queries, 0))).toStrictEqual(["delete", "eq", "select"]);
  });
});

describe("groups.setCollection — a group joins collections as a single unit", () => {
  it("writes collection_id for a move into a collection", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "g1" }], error: null }));
    await setCollection({ collectionId: "c2", groupId: "g1" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ collection_id: "c2" });
  });

  it("writes null to float the group standalone (the setGroupCollection clear shape)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "g1" }], error: null }));
    await setCollection({ collectionId: null, groupId: "g1" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ collection_id: null });
  });
});

describe("groups.setDatasetGroup — the datasets-side group assignment", () => {
  it("writes datasets.group_id (never the collection join table)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "d1" }], error: null }));
    await setDatasetGroup({ datasetId: "d1", groupId: "g1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("datasets");
    expect(firstArg(query, "update")).toStrictEqual({ group_id: "g1" });
    expect(argsOf(query, "eq")).toStrictEqual(["id", "d1"]);
  });

  it("clears with null (the setSchemaGroup clear shape)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "d1" }], error: null }));
    await setDatasetGroup({ datasetId: "d1", groupId: null }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ group_id: null });
  });
});

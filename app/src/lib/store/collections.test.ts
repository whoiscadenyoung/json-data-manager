// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  addToCollection,
  create,
  getQueryOptions,
  list,
  listCollectionsByDataset,
  listDatasets,
  listMemberships,
  listQueryOptions,
  removeFromCollection,
  remove,
  update,
} from "./collections";
import { CATALOG_READ_LIMIT } from "./datasets";
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

/** Pre-aliased (camelCase) — the stub skips PostgREST's `select` aliases, so fixtures arrive in the aliased shape the real service hands back. */
function collectionRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-03T00:00:00+00:00",
    createdBy: "11111111-1111-1111-1111-111111111111",
    description: null,
    id,
    name: `Collection ${id}`,
    updatedAt: "2026-11-03T00:00:00+00:00",
    ...overrides,
  };
}

describe("collections.list / get — the catalog's collection feed", () => {
  it("selects the collections table newest-first and maps the columns to consumer shape", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [collectionRow("c2", { createdAt: "2026-11-03T01:00:00+00:00" }), collectionRow("c1")],
      error: null,
    }));
    const rows = await list({ supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("collections");
    expect(allArgs(query, "order")).toStrictEqual([["created_at", { ascending: false }]]);
    expect(rows[0]).toStrictEqual({
      createdAt: "2026-11-03T01:00:00+00:00",
      createdBy: "11111111-1111-1111-1111-111111111111",
      description: null,
      id: "c2",
      name: "Collection c2",
      updatedAt: "2026-11-03T00:00:00+00:00",
    });
    expect(firstArg(query, "limit")).toBe(CATALOG_READ_LIMIT);
  });

  it("get returns null on an empty read (the RLS not-found shape) and keys its query options", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: null }));
    const options = getQueryOptions({ collectionId: "c1" }, { supabase: client });
    expect(options.queryKey).toStrictEqual(["pg:collections", "get", { collectionId: "c1" }]);
    await expect(runQueryOptions(options)).resolves.toBe(null);
  });

  it("list keys its query options under pg:collections", () => {
    const { client } = stubSupabase();
    expect(listQueryOptions({ supabase: client }).queryKey).toStrictEqual([
      "pg:collections",
      "list",
    ]);
  });
});

describe("collections.listDatasets — the member join, RLS-scoped by the embed", () => {
  it("joins datasets!inner through the join table filtered on collection_id and strips the embed", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [{ datasets: { id: "d1", title: "Grant sites" } }],
      error: null,
    }));
    const rows = await listDatasets({ collectionId: "c1" }, { supabase: client });
    expect(rows).toStrictEqual([{ id: "d1", title: "Grant sites" }]);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("collection_datasets");
    expect(String(firstArg(query, "select"))).toContain("datasets!inner(");
    expect(String(firstArg(query, "select"))).toContain("jsonSchema:json_schema");
    expect(argsOf(query, "eq")).toStrictEqual(["collection_id", "c1"]);
    expect(firstArg(query, "limit")).toBe(CATALOG_READ_LIMIT);
  });
});

describe("collections.listMemberships — the listSchemaCollections parity read", () => {
  it("reads the denormalized kind rows, bounded by the catalog read limit", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        { collectionId: "c1", datasetId: "d1", kind: "geospatial" },
        { collectionId: "c1", datasetId: "d2", kind: null },
      ],
      error: null,
    }));
    const rows = await listMemberships({ supabase: client });
    expect(rows).toStrictEqual([
      { collectionId: "c1", datasetId: "d1", kind: "geospatial" },
      { collectionId: "c1", datasetId: "d2", kind: null },
    ]);
    expect(firstArg(queryAt(queries, 0), "limit")).toBe(CATALOG_READ_LIMIT);
  });
});

describe("collections.listCollectionsByDataset — the reverse lookup", () => {
  it("joins collections!inner filtered on dataset_id (the by_dataset index's direction)", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [{ collections: collectionRow("c1") }],
      error: null,
    }));
    const rows = await listCollectionsByDataset({ datasetId: "d1" }, { supabase: client });
    expect(rows[0]).toMatchObject({ id: "c1", name: "Collection c1" });
    const query = queryAt(queries, 0);
    expect(String(firstArg(query, "select"))).toContain("collections!inner(");
    expect(argsOf(query, "eq")).toStrictEqual(["dataset_id", "d1"]);
  });
});

describe("collections.create / update — the component's name rule", () => {
  it("inserts the collection and returns its id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "new-c" }, error: null }));
    const id = await create({ name: "Grant data" }, { supabase: client });
    expect(id).toBe("new-c");
    expect(queryAt(queries, 0).table).toBe("collections");
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({ name: "Grant data" });
    expect(methodList(queryAt(queries, 0))).toContain("single");
  });

  it("omits an absent description and keeps one that is given", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "c" }, error: null }));
    await create({ description: "Multi-year", name: "Grants" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({
      description: "Multi-year",
      name: "Grants",
    });
  });

  it("rejects blank names client-side with the component's message (no query fired)", async () => {
    const { client, queries } = stubSupabase();
    await expect(create({ name: "   " }, { supabase: client })).rejects.toThrowError(
      "Collection must have a name",
    );
    await expect(
      update({ collectionId: "c1", name: "" }, { supabase: client }),
    ).rejects.toThrowError("Collection must have a name");
    expect(queries.length).toBe(0);
  });

  it("update patches only the given fields (the component's patch semantics)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "c1" }], error: null }));
    await update({ collectionId: "c1", description: "New text" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(firstArg(query, "update")).toStrictEqual({ description: "New text" });
    expect(argsOf(query, "eq")).toStrictEqual(["id", "c1"]);
  });
});

describe("collections.remove — the cascade delete", () => {
  it("deletes by id and surfaces a denial as a thrown error", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "c1" }], error: null }));
    await remove({ collectionId: "c1" }, { supabase: client });
    expect(methodList(queryAt(queries, 0))).toStrictEqual(["delete", "eq", "select"]);
  });

  it("throws the PostgREST error on denial", async () => {
    const { client } = stubSupabase(() => ({
      data: null,
      error: postgrestError("permission denied"),
    }));
    await expect(remove({ collectionId: "c1" }, { supabase: client })).rejects.toThrowError(
      "permission denied (42501)",
    );
  });
});

describe("collections.addToCollection / removeFromCollection — membership ops", () => {
  it("addToCollection upserts the pair with ignoreDuplicates (the component's idempotent no-op) and never sends kind (the trigger stamps it)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ dataset_id: "d1" }], error: null }));
    await addToCollection({ collectionId: "c1", datasetId: "d1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("collection_datasets");
    expect(firstArg(query, "upsert")).toStrictEqual({ collection_id: "c1", dataset_id: "d1" });
    const upsertArgs = argsOf(query, "upsert");
    expect(upsertArgs[1]).toStrictEqual({
      ignoreDuplicates: true,
      onConflict: "collection_id,dataset_id",
    });
    expect(JSON.stringify(firstArg(query, "upsert"))).not.toContain("kind");
  });

  it("removeFromCollection deletes exactly one pair", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await removeFromCollection({ collectionId: "c1", datasetId: "d1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(methodList(query)).toStrictEqual(["delete", "eq", "eq", "select"]);
    expect(firstArg(query, "select")).toBe("dataset_id");
    expect(allArgs(query, "eq")).toStrictEqual([
      ["collection_id", "c1"],
      ["dataset_id", "d1"],
    ]);
  });
});

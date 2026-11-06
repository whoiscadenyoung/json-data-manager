// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { create, listForDatasets, relatedRecords, remove, update } from "./relations";
import { argsOf, queryAt, stubSupabase } from "./test-support";

/** Pre-aliased (camelCase) — the stub skips PostgREST's `select` aliases, so fixtures arrive in the aliased shape the real service hands back. */
function relationRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    cardinality: "N-M",
    config: { direction: "forward", predicate: "within" },
    createdAt: "2026-11-06T00:00:00Z",
    createdBy: "11111111-1111-1111-1111-111111111111",
    fromDataset: "ds-parks",
    id,
    kind: "spatial",
    toDataset: "ds-states",
    updatedAt: "2026-11-06T00:00:00Z",
    ...overrides,
  };
}

/** The value, or a loud failure (the no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

describe("relations.listForDatasets — every relation touching the given datasets", () => {
  it("filters from- or to-side with one or-filter over the sorted id list", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [relationRow("r1")] }));
    const rows = await listForDatasets({ datasetIds: ["ds-b", "ds-a"] }, { supabase: client });
    expect(rows.map((row) => row.id)).toEqual(["r1"]);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("dataset_relations");
    // Sorted so the query key (and the PostgREST filter) is stable.
    expect(argsOf(query, "or")).toStrictEqual([
      "from_dataset.in.(ds-a,ds-b),to_dataset.in.(ds-a,ds-b)",
    ]);
  });

  it("short-circuits on an empty id list (no query fired)", async () => {
    const { client, queries } = stubSupabase();
    const rows = await listForDatasets({ datasetIds: [] }, { supabase: client });
    expect(rows).toEqual([]);
    expect(queries.length).toBe(0);
  });
});

describe("relations.create — declare one relation", () => {
  it("inserts the snake_case payload and answers the aliased row", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: relationRow("r9", { kind: "key", config: { fromKey: "park_id", toKey: "id" } }),
    }));
    const row = await create(
      {
        cardinality: "1-N",
        config: { fromKey: "park_id", toKey: "id" },
        fromDataset: "ds-visits",
        kind: "key",
        toDataset: "ds-parks",
      },
      { supabase: client },
    );
    expect(present(row).kind).toBe("key");
    const query = queryAt(queries, 0);
    const insert = argsOf(query, "insert") as unknown as Array<Record<string, unknown>>;
    expect(present(insert[0]).cardinality).toBe("1-N");
    expect(present(insert[0]).from_dataset).toBe("ds-visits");
    expect(present(insert[0]).to_dataset).toBe("ds-parks");
    expect(methodHas(query, "single")).toBe(true);
  });

  it("answers null when denied (not both ends' editor — the silent-denial rule)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    const row = await create(
      {
        cardinality: "N-M",
        config: { direction: "forward", predicate: "within" },
        fromDataset: "ds-a",
        kind: "spatial",
        toDataset: "ds-b",
      },
      { supabase: client },
    );
    expect(row).toBeNull();
  });
});

describe("relations.update — cardinality/config fixes", () => {
  it("patches only the provided fields and answers the affected count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "r1" }] }));
    const affected = await update({ cardinality: "1-1", relationId: "r1" }, { supabase: client });
    expect(affected).toBe(1);
    const query = queryAt(queries, 0);
    const patch = argsOf(query, "update") as unknown as Array<Record<string, unknown>>;
    expect(present(patch[0]).cardinality).toBe("1-1");
    expect(Object.hasOwn(present(patch[0]), "config")).toBe(false);
  });

  it("answers 0 when denied or gone", async () => {
    const { client } = stubSupabase(() => ({ data: [] }));
    const affected = await update(
      { config: { direction: "reverse", predicate: "within" }, relationId: "r-gone" },
      { supabase: client },
    );
    expect(affected).toBe(0);
  });
});

describe("relations.remove", () => {
  it("deletes by id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "r1" }] }));
    await remove({ relationId: "r1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(argsOf(query, "eq")).toStrictEqual(["id", "r1"]);
    expect(methodHas(query, "delete")).toBe(true);
  });
});

describe("relations.relatedRecords — the bounded runtime query", () => {
  it("rides the dataset_relation_records RPC with the caller's bounds", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        {
          data: { name: "Bear Lake" },
          entry_id: "e1",
          geometry: { coordinates: [-105.6, 40.3], type: "Point" },
          geometry_type: "Point",
          has_more: false,
        },
      ],
    }));
    const rows = await relatedRecords(
      {
        bbox: [-110, 40, -104, 45],
        datasetId: "ds-parks",
        entryId: "e-clicked",
        limit: 50,
        offset: 100,
        projectId: "p1",
        relationId: "r1",
      },
      { supabase: client },
    );
    const record = present(rows[0]);
    expect(record.entry_id).toBe("e1");
    expect(record.has_more).toBe(false);
    const query = queryAt(queries, 0);
    expect(query.rpc).toBe("dataset_relation_records");
    expect(query.rpcArgs).toStrictEqual({
      p_bbox: [-110, 40, -104, 45],
      p_dataset: "ds-parks",
      p_entry: "e-clicked",
      p_limit: 50,
      p_offset: 100,
      p_project: "p1",
      p_relation: "r1",
    });
  });

  it("passes null bbox when the caller omits the viewport", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [] }));
    await relatedRecords(
      { datasetId: "ds-a", entryId: "e1", projectId: "p1", relationId: "r1" },
      { supabase: client },
    );
    const query = queryAt(queries, 0);
    expect(query.rpcArgs).toMatchObject({ p_bbox: null, p_limit: 200, p_offset: 0 });
  });
});

/** Whether the chain recorded an operation with `method`. */
function methodHas(query: ReturnType<typeof queryAt>, method: string): boolean {
  return query.operations.some((operation) => operation.method === method);
}

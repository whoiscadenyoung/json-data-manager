// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { create, listQueryOptions, retire, remove } from "./tags";
import { argsOf, firstArg, queryAt, runQueryOptions, stubSupabase } from "./test-support";

/** The element at the index, or a loud failure (the no-optional-chaining test style). */
function at<T>(rows: ReadonlyArray<T>, index: number): T {
  const item = rows[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index} (have ${rows.length}).`);
  }
  return item;
}

describe("tags reads", () => {
  it("listQueryOptions selects the camelCase projection filtered by dataset, newest first", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        {
          createdAt: "2026-11-04T00:00:00+00:00",
          createdBy: "user-1",
          datasetId: "d1",
          id: "t1",
          name: "v1",
          retiredAt: null,
          versionId: "ver-1",
        },
      ],
    }));
    const rows = await runQueryOptions(listQueryOptions({ datasetId: "d1" }, { supabase: client }));
    expect(rows.length).toBe(1);
    expect(at(rows, 0).name).toBe("v1");
    const query = queryAt(queries, 0);
    expect(query.table).toBe("tags");
    expect(argsOf(query, "eq")).toStrictEqual(["dataset_id", "d1"]);
    expect(argsOf(query, "order")).toStrictEqual(["created_at", { ascending: false }]);
  });
});

describe("tags writes — rows-affected returns (the silent-denial rule)", () => {
  it("create inserts the row and reads it back (the SELECT policy passes RETURNING)", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: {
        createdAt: "2026-11-04T00:00:00+00:00",
        createdBy: "user-1",
        datasetId: "d1",
        id: "t1",
        name: "v1",
        retiredAt: null,
        versionId: "ver-1",
      },
    }));
    const row = await create(
      { datasetId: "d1", name: "v1", versionId: "ver-1" },
      { supabase: client },
    );
    expect(row.id).toBe("t1");
    expect(row.retiredAt).toBeNull();
    const query = queryAt(queries, 0);
    expect(query.table).toBe("tags");
    expect(firstArg(query, "insert")).toStrictEqual({
      dataset_id: "d1",
      name: "v1",
      version_id: "ver-1",
    });
    expect(query.operations.some((op) => op.method === "single")).toBe(true);
  });

  it("create refuses a null readback (a denied insert must not look like success)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    await expect(
      create({ datasetId: "d1", name: "v1", versionId: "ver-1" }, { supabase: client }),
    ).rejects.toThrow("Tag insert returned no row.");
  });

  it("retire stamps retired_at and answers the affected count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "t1" }] }));
    const affected = await retire({ tagId: "t1" }, { supabase: client });
    expect(affected).toBe(1);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("tags");
    const patch = firstArg(query, "update") as { retired_at: unknown };
    expect(typeof patch.retired_at).toBe("string");
    expect(argsOf(query, "eq")).toStrictEqual(["id", "t1"]);
  });

  it("retire answers 0 when RLS filtered the write (denied, not thrown)", async () => {
    const { client } = stubSupabase(() => ({ data: [] }));
    expect(await retire({ tagId: "t1" }, { supabase: client })).toBe(0);
  });

  it("remove deletes the row and answers the affected count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "t1" }] }));
    expect(await remove({ tagId: "t1" }, { supabase: client })).toBe(1);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("tags");
    expect(query.operations.some((op) => op.method === "delete")).toBe(true);
  });
});

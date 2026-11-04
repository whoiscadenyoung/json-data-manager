import { afterEach, describe, expect, it, vi } from "vitest";

// The module's import chain reaches `#/env` (the worker client needs the
// Supabase URL/key); CI has no .env.local — the stage-3-ci-tree-lessons
// mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { stubSupabase, argsOf } from "#/lib/store/test-support";

import { loadPgTable, pgWorkerSupabaseClient } from "./analysis-pg";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pgWorkerSupabaseClient — the worker's per-run client policy", () => {
  it("refuses a null token loudly (an unauthenticated client would silently read zero RLS-visible rows)", async () => {
    await expect(pgWorkerSupabaseClient(async () => null)).rejects.toThrow(
      "Sign in to analyze Postgres datasets.",
    );
  });

  it("builds a client from the fetched token", async () => {
    const client = await pgWorkerSupabaseClient(async () => "token-1");
    expect(client).toBeDefined();
  });
});

describe("loadPgTable — the seam's row paging, adapted into engine records", () => {
  it("pages the dataset through the seam and adapts each row via entryDataRecord (non-object data degrades to {})", async () => {
    const stub = stubSupabase((query) => {
      if (query.table !== "entries") {
        return { data: [] };
      }
      const eq = argsOf(query, "eq"),
        datasetId = eq.length > 1 ? eq[1] : undefined;
      if (datasetId !== "ds-1") {
        return { data: [] };
      }
      return {
        data: [
          {
            createdAt: "2026-11-04T00:00:00+00:00",
            datasetId: "ds-1",
            data: { state: "VT", awards: 3 },
            geometryType: null,
            id: "e-1",
          },
          {
            createdAt: "2026-11-04T00:00:01+00:00",
            datasetId: "ds-1",
            data: "not an object",
            geometryType: null,
            id: "e-2",
          },
        ],
      };
    });
    const table = await loadPgTable(
      {
        as: "source",
        columns: [{ name: "state", type: "string" }],
        schemaId: "ds-1",
        title: "Awards",
      },
      stub.client,
    );
    expect(table.rows).toEqual([{ awards: 3, state: "VT" }, {}]);
    expect(table.columns).toEqual([{ name: "state", type: "string" }]);
    expect(table.title).toBe("Awards");
    // The read is the seam's dataset-scoped entries page (exhaustion rides
    // nextCursor; pinned by dataset-rows-pg.test.ts).
    const entriesQuery = stub.queries.find((query) => query.table === "entries");
    expect(entriesQuery).toBeDefined();
    expect(argsOf(entriesQuery ?? stub.queries[0], "eq")).toContain("ds-1");
  });

  it("degrades to engine inference when the request carries no declared columns", async () => {
    const stub = stubSupabase((query) => {
      if (query.table === "entries") {
        const eq = argsOf(query, "eq"),
          datasetId = eq.length > 1 ? eq[1] : undefined;
        return datasetId === "ds-1"
          ? {
              data: [
                {
                  createdAt: "2026-11-04T00:00:00+00:00",
                  datasetId: "ds-1",
                  data: { n: 1 },
                  geometryType: null,
                  id: "e-1",
                },
              ],
            }
          : { data: [] };
      }
      return { data: [] };
    });
    const table = await loadPgTable({ as: "source", schemaId: "ds-1" }, stub.client);
    expect(table.rows).toEqual([{ n: 1 }]);
    expect(table.columns).toEqual([]);
    expect(table.title).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

// The seam's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import type { DatasetEntryRow } from "#/lib/dataset-rows-pg";
import { stubSupabase, argsOf } from "#/lib/store/test-support";

import { pgExportEntries, pgExportEntryOf, pgExportGeometries } from "./pg-export";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One entry row's wire shape, with a stable created_at for the keyset read. */
function entryOf(id: string, data: unknown, geometryType: DatasetEntryRow["geometryType"]) {
  return {
    createdAt: "2026-11-04T00:00:00+00:00",
    datasetId: "ds-1",
    data,
    geometryType,
    id,
  };
}

describe("pgExportEntryOf — the PG geometry key is the entry id", () => {
  it("maps a row with geometry to its own id (the 1:1 geometry-row key) and one without to no geometry", () => {
    const withGeometry = pgExportEntryOf(entryOf("e-1", { state: "VT" }, "Point")),
      without = pgExportEntryOf(entryOf("e-2", { state: "NH" }, null));
    expect(withGeometry).toEqual({ _id: "e-1", data: { state: "VT" }, geometryId: "e-1" });
    expect(without.geometryId).toBeUndefined();
  });
});

describe("pgExportEntries — the seam's whole-dataset read, adapted", () => {
  it("maps every row of the one-shot read through pgExportEntryOf and filters on the dataset", async () => {
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
        data: [entryOf("e-1", { state: "VT" }, "Point"), entryOf("e-2", { state: "NH" }, null)],
      };
    });
    const entries = await pgExportEntries("ds-1", { supabase: stub.client });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      _id: "e-1",
      data: { state: "VT" },
      geometryId: "e-1",
    });
    // The entries query is the dataset-scoped whole read (the seam's own
    // filter chain — asserted here, owned by dataset-rows-pg.test.ts).
    const entriesQuery = stub.queries.find((query) => query.table === "entries");
    expect(entriesQuery).toBeDefined();
    expect(argsOf(entriesQuery ?? stub.queries[0], "eq")).toContain("ds-1");
  });
});

describe("pgExportGeometries — inline jsonb resolves, storage-backed payloads ride signed URLs", () => {
  it("resolves the inline row synchronously and leaves a row whose payload fetch fails unresolved (never failing the export)", async () => {
    const stub = stubSupabase(
      (query) => {
        if (query.rpc === "dataset_rows_for_tiles") {
          return {
            data: [
              {
                bbox: null,
                data: {},
                entry_id: "e-1",
                geometry: { coordinates: [0, 0], type: "Point" },
                geometry_source_path: null,
                geometry_type: "Point",
                next_cursor: null,
              },
              {
                bbox: null,
                data: {},
                entry_id: "e-2",
                geometry: null,
                geometry_source_path: "oversized/e-2.json",
                geometry_type: "Point",
                next_cursor: null,
              },
            ],
          };
        }
        return { data: [] };
      },
      // The oversized payload's signed URL FAILS — the seam's per-row rule:
      // that row's geometry stays unresolved, everything else still exports.
      { signedUrlPaths: ["oversized/e-2.json"] },
    );
    const resolved = await pgExportGeometries("ds-1", { supabase: stub.client });
    expect(resolved.get("e-1")).toEqual({ coordinates: [0, 0], type: "Point" });
    expect(resolved.has("e-2")).toBe(false);
    // The failed signing short-circuits BEFORE a URL is recorded — the
    // store stub records only successful signatures.
    expect(stub.signedUrls).toEqual([]);
  });

  it("fetches a storage-backed payload through its signed URL", async () => {
    const POINT = { coordinates: [1, 2], type: "Point" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => POINT, ok: true })),
    );
    const stub = stubSupabase((query) => {
      if (query.rpc === "dataset_rows_for_tiles") {
        return {
          data: [
            {
              bbox: null,
              data: {},
              entry_id: "e-9",
              geometry: null,
              geometry_source_path: "oversized/e-9.json",
              geometry_type: "Point",
              next_cursor: null,
            },
          ],
        };
      }
      return { data: [] };
    });
    const resolved = await pgExportGeometries("ds-1", { supabase: stub.client });
    expect(resolved.get("e-9")).toEqual(POINT);
    const firstSigned = stub.signedUrls[0];
    expect(firstSigned === undefined ? undefined : firstSigned.path).toBe("oversized/e-9.json");
  });
});

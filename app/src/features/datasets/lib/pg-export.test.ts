import { afterEach, describe, expect, it, vi } from "vitest";

// The seam's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import type { DatasetEntryRow } from "#/lib/dataset-rows-pg";
import type { DerivedDatasetSummaryRow } from "#/lib/store/derived";
import { stubSupabase, argsOf } from "#/lib/store/test-support";

import type { ExportableEntry } from "./export";
import {
  pgApplyJoinedFields,
  pgExportEntries,
  pgExportEntryOf,
  pgExportGeometries,
  pgReadyRowsOf,
} from "./pg-export";

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

describe("pgReadyRowsOf — the readiness gate over the store's summaries", () => {
  it("keeps only explicitly saved rows whose read-time health is ready", () => {
    const summaries: DerivedDatasetSummaryRow[] = [
      summaryOf("row-1", "saved", "ready"),
      summaryOf("row-2", "draft", "ready"),
      summaryOf("row-3", "saved", "stale"),
      summaryOf("row-4", "saved", "orphaned"),
    ];
    const ready = pgReadyRowsOf(summaries);
    expect(ready.map((row) => row._id)).toEqual(["row-1"]);
    expect(pgReadyRowsOf(undefined)).toEqual([]);
  });
});

/** One summary projection row (the store's listBySource shape) with a stable source. */
function summaryOf(
  id: string,
  status: DerivedDatasetSummaryRow["status"],
  health: DerivedDatasetSummaryRow["health"],
): DerivedDatasetSummaryRow {
  return {
    carriesSql: false,
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "creator-1",
    description: null,
    health,
    id,
    sourceDatasetId: "ds-1",
    status,
    title: `Spec ${id}`,
  };
}

describe("pgApplyJoinedFields — the toggled export's enrichment step", () => {
  it("folds only the ready rows' specs onto their source's entries and reports the skipped rest", async () => {
    const stubClient = stubSupabase((query) => {
      // The ready row's full doc read (loadSpecsBySource) — the spec reads
      // the lookup side "lookup-ds".
      if (query.table === "derived_datasets" && query.rpc === null) {
        const eq = argsOf(query, "eq"),
          id = eq.length > 1 ? eq[1] : undefined,
          selectingSpec = query.operations.some(
            (operation) =>
              operation.method === "select" && String(operation.args[0]).includes("spec"),
          );
        if (selectingSpec && id === "row-1") {
          return {
            data: [
              {
                createdAt: "2026-11-04T00:00:00+00:00",
                createdBy: "creator-1",
                dependsOn: ["ds-1", "lookup-ds"],
                description: null,
                id: "row-1",
                sourceDatasetId: "ds-1",
                sourceDerivedId: null,
                spec: {
                  operations: [
                    {
                      baseKey: "state",
                      kind: "lookup",
                      lookupDatasetId: "lookup-ds",
                      lookupKey: "code",
                      namespace: "Lookups",
                    },
                  ],
                  sourceDatasetId: "ds-1",
                },
                status: "saved",
                title: "Enriched",
                updatedAt: "2026-11-04T00:00:00+00:00",
              },
            ],
          };
        }
        // The health walk's registry leg for "lookup-ds" — not a registry row.
        return { data: [] };
      }
      if (query.table === "datasets") {
        // The health walk's component leg for "lookup-ds" — exists, with the
        // declared column the lookup key names.
        return { data: [{ properties: ["code", "name"], title: "Lookups" }] };
      }
      if (query.table === "entries") {
        const eq = argsOf(query, "eq"),
          datasetId = eq.length > 1 ? eq[1] : undefined;
        if (datasetId === "ds-1") {
          return { data: [] }; // the source's rows come from the caller's map
        }
        if (datasetId === "lookup-ds") {
          return {
            data: [
              entryOf("l-1", { code: "VT", name: "Vermont" }, null),
              entryOf("l-2", { code: "NH", name: "New Hampshire" }, null),
            ],
          };
        }
        return { data: [] };
      }
      return { data: [] };
    });

    const entries: ExportableEntry[] = [
      { _id: "e-1", data: { state: "VT" }, geometryId: undefined },
      { _id: "e-2", data: { state: "ZZ" }, geometryId: undefined },
    ];
    const rowsBySource = new globalThis.Map<string, ExportableEntry[]>([["ds-1", entries]]);
    const skipped = await pgApplyJoinedFields({
      options: { supabase: stubClient.client },
      rows: [
        summaryOf("row-1", "saved", "ready"),
        summaryOf("row-2", "draft", "ready"),
        summaryOf("row-3", "saved", "stale"),
      ],
      rowsBySource,
    });

    // Both saved-but-not-ready rows were skipped; only the ready one folded.
    expect(skipped).toBe(2);
    const enriched = rowsBySource.get("ds-1");
    expect(enriched).toBeDefined();
    const first = enriched === undefined ? undefined : enriched[0],
      second = enriched === undefined ? undefined : enriched[1];
    // The matched row carries the namespaced enrichment; the unmatched one
    // survives with null enriched fields (the left join's recorded rule).
    expect(first).toEqual({
      _id: "e-1",
      data: { "Lookups.name": "Vermont", state: "VT" },
      geometryId: undefined,
    });
    expect(second).toEqual({
      _id: "e-2",
      data: { "Lookups.name": null, state: "ZZ" },
      geometryId: undefined,
    });
  });
});

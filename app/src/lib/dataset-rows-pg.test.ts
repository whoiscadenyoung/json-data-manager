// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The seam's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any seam import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { sharedClient } from "#/lib/store/client";
import { allArgs, firstArg, queryAt, stubSupabase } from "#/lib/store/test-support";

import {
  applyEntryRowSpecs,
  applyGeometryRowSpec,
  applyGeometryRowSpecs,
  type DatasetEntryRow,
  type DatasetGeometryRow,
  ENTRIES_FETCH_PAGE_SIZE,
  ENTRIES_PAGE_SIZE,
  entryDataRecord,
  fetchDatasetEntryRows,
  fetchDatasetGeometryRows,
  forEachDatasetEntryPage,
  forEachDatasetGeometryPage,
  GEOMETRY_PAGE_ROWS,
  resolveDatasetGeometryRows,
  resolveGeometryRows,
} from "./dataset-rows-pg";

/**
 * The row fixture. The `id` slot rides the uuid wire shape via `uuidOf` —
 * the keyset pager encodes the last row's id into a continuation cursor, and
 * the store's cursor decode guard (the or= injection fix) rejects anything
 * that is not the store's own wire shape. `data.id` keeps the short key so
 * data-side assertions stay readable.
 */
function uuidOf(key: string): string {
  const hex = Array.from(key)
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(12, "0")
    .slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

function entryRow(id: string, overrides: Partial<DatasetEntryRow> = {}): DatasetEntryRow {
  return {
    createdAt: "2026-11-03T00:00:00+00:00",
    data: { id },
    datasetId: "d1",
    geometryType: null,
    id: uuidOf(id),
    ...overrides,
  };
}

function geometryRow(
  entryId: string,
  overrides: Partial<DatasetGeometryRow> = {},
): DatasetGeometryRow {
  return {
    bbox: null,
    data: {},
    datasetId: "d1",
    entryId,
    geometry: { coordinates: [0, entryId.length], type: "Point" },
    sourcePath: null,
    type: "Point",
    ...overrides,
  };
}

describe("page sizes", () => {
  it("keep the reactive width pinned at the persisted-hash value (200)", () => {
    expect(ENTRIES_PAGE_SIZE).toBe(200);
  });

  it("rise where the Convex byte budgets bounded them before (design §8.3)", () => {
    // The fetch width stays 500 (HTTP-shaped, entries are thin); the geometry
    // width rises to the design's example — the component's byte-budget clamp
    // is what bounded it before, and Postgres has no per-execution cap.
    expect(ENTRIES_FETCH_PAGE_SIZE).toBe(500);
    expect(GEOMETRY_PAGE_ROWS).toBe(2000);
  });
});

/** A full probe-overflowing page: `count` rows + the one probe row that tells the pager there is more. */
function fullPage(count: number): DatasetEntryRow[] {
  return Array.from({ length: count + 1 }, (_, index) => entryRow(`e${index + 1}`));
}

describe("forEachDatasetEntryPage", () => {
  it("chains keyset cursors to exhaustion, handing pages through in order", async () => {
    const { client, queries } = stubSupabase((query) =>
      query.operations.some((operation) => operation.method === "or")
        ? { data: [entryRow("last")], error: null }
        : { data: fullPage(ENTRIES_FETCH_PAGE_SIZE), error: null },
    );
    const seen: string[][] = [];
    await forEachDatasetEntryPage(
      "d1",
      (rows) => {
        seen.push(rows.map((row) => row.id));
      },
      { supabase: client },
    );
    // First page = exactly ENTRIES_FETCH_PAGE_SIZE rows (the probe row is
    // trimmed into the continuation); second page exhausts.
    expect(seen.length).toBe(2);
    expect(seen[0]).toHaveLength(ENTRIES_FETCH_PAGE_SIZE);
    expect(seen[0][0]).toBe(uuidOf("e1"));
    expect(seen[1]).toStrictEqual([uuidOf("last")]);
    expect(queries.length).toBe(2);
    // The second page resumes from the encoded (created_at, id) tuple of the
    // first page's last row — the keyset filter, no OFFSET. Both tuple values
    // ride QUOTED (the cursor injection guard's quoted-value form).
    expect(firstArg(queryAt(queries, 1), "or")).toBe(
      `and(created_at.eq."2026-11-03T00:00:00+00:00",id.lt."${uuidOf(`e${ENTRIES_FETCH_PAGE_SIZE}`)}"),created_at.lt."2026-11-03T00:00:00+00:00"`,
    );
  });

  it("forwards the requested entry order (the group export's ascending contract)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await forEachDatasetEntryPage("d1", () => undefined, {
      entryOrder: "asc",
      supabase: client,
    });
    expect(allArgs(queryAt(queries, 0), "order")).toStrictEqual([
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("pages at ENTRIES_FETCH_PAGE_SIZE", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await forEachDatasetEntryPage("d1", () => undefined, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "limit")).toBe(ENTRIES_FETCH_PAGE_SIZE + 1);
  });
});

describe("fetchDatasetEntryRows", () => {
  it("accumulates every page's rows in page order, exactly once", async () => {
    const { client } = stubSupabase((query) =>
      query.operations.some((operation) => operation.method === "or")
        ? { data: [entryRow("last")], error: null }
        : { data: fullPage(ENTRIES_FETCH_PAGE_SIZE), error: null },
    );
    const rows = await fetchDatasetEntryRows("d1", { supabase: client });
    expect(rows.length).toBe(ENTRIES_FETCH_PAGE_SIZE + 1);
    expect(rows[0]).toMatchObject({ id: uuidOf("e1") });
    expect(rows[ENTRIES_FETCH_PAGE_SIZE]).toMatchObject({ id: uuidOf("last") });
  });
});

describe("forEachDatasetGeometryPage", () => {
  it("pages dataset_rows_for_tiles at GEOMETRY_PAGE_ROWS and stops at a null next_cursor", async () => {
    const { client, queries } = stubSupabase((query) => {
      const args = query.rpcArgs as { p_cursor: string | null };
      return args.p_cursor === null
        ? {
            data: [
              {
                bbox: null,
                data: {},
                entry_id: "e1",
                geometry: { coordinates: [0, 2], type: "Point" },
                geometry_source_path: null,
                geometry_type: "Point",
                next_cursor: "cursor-2",
              },
            ],
            error: null,
          }
        : {
            data: [
              {
                bbox: null,
                data: {},
                entry_id: "e2",
                geometry: { coordinates: [1, 2], type: "Point" },
                geometry_source_path: null,
                geometry_type: "Point",
                next_cursor: null,
              },
            ],
            error: null,
          };
    });
    const seen: string[][] = [];
    await forEachDatasetGeometryPage(
      "d1",
      (rows) => {
        seen.push(rows.map((row) => row.entryId));
      },
      { supabase: client },
    );
    expect(seen).toStrictEqual([["e1"], ["e2"]]);
    expect(queries.length).toBe(2);
    expect(queryAt(queries, 0).rpcArgs).toStrictEqual({
      p_cursor: null,
      p_dataset: "d1",
      p_limit: GEOMETRY_PAGE_ROWS,
    });
    expect(queryAt(queries, 1).rpcArgs).toStrictEqual({
      p_cursor: "cursor-2",
      p_dataset: "d1",
      p_limit: GEOMETRY_PAGE_ROWS,
    });
  });
});

describe("fetchDatasetGeometryRows", () => {
  it("accumulates geometry rows in page order", async () => {
    const { client } = stubSupabase((query) => {
      const args = query.rpcArgs as { p_cursor: string | null };
      return args.p_cursor === null
        ? {
            data: [
              {
                bbox: null,
                data: {},
                entry_id: "e1",
                geometry: { coordinates: [0, 2], type: "Point" },
                geometry_source_path: null,
                geometry_type: "Point",
                next_cursor: "cursor-2",
              },
            ],
            error: null,
          }
        : {
            data: [
              {
                bbox: null,
                data: {},
                entry_id: "e2",
                geometry: { coordinates: [1, 2], type: "Point" },
                geometry_source_path: null,
                geometry_type: "Point",
                next_cursor: null,
              },
            ],
            error: null,
          };
    });
    const rows = await fetchDatasetGeometryRows("d1", { supabase: client });
    expect(rows.map((row) => row.entryId)).toStrictEqual(["e1", "e2"]);
  });
});

// ---------------------------------------------------------------------------
// The spec-application step — identity stubs plus the popup executor, the
// PG-row mirror of the semantics `dataset-rows.test.ts` pins
// ---------------------------------------------------------------------------

describe("spec stubs", () => {
  it("are identity — same rows, same reference — until specs are handed in", () => {
    const entries = [entryRow("e1")];
    const geometries = [geometryRow("e1")];
    const firstGeometry = geometries[0];
    expect(applyEntryRowSpecs(entries)).toBe(entries);
    expect(applyGeometryRowSpecs(geometries)).toBe(geometries);
    expect(applyGeometryRowSpec(firstGeometry)).toBe(firstGeometry);
  });
});

describe("entryDataRecord", () => {
  it("adapt object data as the engine's record and non-object data as keyless", () => {
    expect(entryDataRecord(entryRow("e1", { data: { a: 1 } }))).toStrictEqual({ a: 1 });
    expect(entryDataRecord(entryRow("e1", { data: [1, 2] }))).toStrictEqual({});
  });
});

// ---------------------------------------------------------------------------
// resolveGeometryRows — inline jsonb passthrough + Storage-backed signed URLs
// ---------------------------------------------------------------------------

describe("resolveGeometryRows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves inline rows synchronously from the verbatim jsonb, keyed by entryId", async () => {
    const rows = [geometryRow("e1"), geometryRow("e2", { geometry: null })];
    const resolved = await resolveGeometryRows(rows, { supabase: stubSupabase().client });
    expect(resolved.get("e1")).toStrictEqual({ coordinates: [0, 2], type: "Point" });
    expect(resolved.has("e2")).toBe(false);
  });

  it("resolves storage-backed rows through a signed URL fetch", async () => {
    const { client, signedUrls } = stubSupabase();
    const fetchStub = vi.fn<() => Promise<{ json: () => Promise<unknown>; ok: boolean }>>(
      async () => ({
        ok: true,
        json: async () => ({ coordinates: [5, 6], type: "Point" }),
      }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const resolved = await resolveGeometryRows(
      [geometryRow("e1", { geometry: null, sourcePath: "d1/e1.json" })],
      { supabase: client },
    );
    expect(resolved.get("e1")).toStrictEqual({ coordinates: [5, 6], type: "Point" });
    expect(signedUrls).toStrictEqual([
      { bucket: "geometries", path: "d1/e1.json", ttlSeconds: 3600 },
    ]);
    expect(fetchStub).toHaveBeenCalledWith("https://signed.test/geometries/d1/e1.json");
  });

  it("leaves a failed row unresolved instead of failing the whole resolve", async () => {
    const { client } = stubSupabase();
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<{ ok: boolean; status: number }>>(async () => ({
        ok: false,
        status: 404,
      })),
    );
    const resolved = await resolveGeometryRows(
      [geometryRow("bad", { geometry: null, sourcePath: "d1/gone.json" }), geometryRow("good")],
      { supabase: client },
    );
    expect(resolved.has("bad")).toBe(false);
    expect(resolved.has("good")).toBe(true);
  });
});

describe("resolveDatasetGeometryRows", () => {
  it("composes fetch + resolve into the export's [entryId, Geometry] entries", async () => {
    const { client } = stubSupabase(() => ({
      data: [
        {
          bbox: null,
          data: {},
          entry_id: "e1",
          geometry: { coordinates: [0, 2], type: "Point" },
          geometry_source_path: null,
          geometry_type: "Point",
          next_cursor: null,
        },
      ],
      error: null,
    }));
    const resolved = await resolveDatasetGeometryRows("d1", { supabase: client });
    expect(resolved).toStrictEqual([["e1", { coordinates: [0, 2], type: "Point" }]]);
  });
});

describe("sharedClient (re-exported)", () => {
  it("is the store's shared browser client, stable across calls", () => {
    expect(sharedClient()).toBe(sharedClient());
  });
});

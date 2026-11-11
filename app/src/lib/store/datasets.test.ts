// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  CATALOG_READ_LIMIT,
  create,
  getQueryOptions,
  listByCreatorQueryOptions,
  listDraftSummariesQueryOptions,
  listQueryOptions,
  listSummariesQueryOptions,
  markImportComplete,
  maxTileCacheVersionQueryOptions,
  remove,
  setEditPolicy,
  setVisibility,
  update,
} from "./datasets";
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

/** One full datasets wire row with every column the summary projection needs. */
function datasetWire(id: string, overrides: Record<string, unknown> = {}) {
  return {
    bbox: null,
    createdBy: "user-1",
    createdAt: "2026-11-03T00:00:00+00:00",
    description: "d",
    editPolicy: "open",
    entryCount: 3,
    featureCount: 3,
    geometryType: "Point",
    groupId: null,
    id,
    isGeospatial: true,
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveBytes: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileCacheVersion: 7,
    properties: ["name", "grant"],
    visibility: "signed-in",
    source: null,
    title: `Dataset ${id}`,
    ...overrides,
  };
}

describe("datasets.listSummaries", () => {
  it("derives fieldCount from the declared properties column and drops the payload columns", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [datasetWire("d1"), datasetWire("d2", { properties: null })],
      error: null,
    }));
    const rows = await runQueryOptions(listSummariesQueryOptions({ supabase: client }));
    expect(rows.map((row) => row.fieldCount)).toStrictEqual([2, 0]);
    expect(rows[0]).toMatchObject({ id: "d1", title: "Dataset d1" });
    // The heavy payload never rides the summary — `json_schema` is absent
    // from the select entirely (the #53 projection rule).
    const select = String(firstArg(queryAt(queries, 0), "select"));
    expect(select).not.toContain("jsonSchema");
    expect(select).toContain("properties");
    // The published-only gate (the stage-4 drafts-leak fix): can_view_dataset
    // ADMITS a creator's own draft, so the filter — not RLS — is what keeps
    // the summary projection matching the Convex listSummaries.
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["lifecycle", "published"]);
  });

  it("keys and bounds like the catalog read (newest first, CATALOG_READ_LIMIT)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    const options = listSummariesQueryOptions({ supabase: client });
    expect(options.queryKey).toStrictEqual(["pg:datasets", "listSummaries", CATALOG_READ_LIMIT]);
    await runQueryOptions(options);
    const first = queryAt(queries, 0);
    expect(firstArg(first, "order")).toBe("created_at");
    expect(allArgs(first, "order")).toStrictEqual([["created_at", { ascending: false }]]);
    expect(firstArg(first, "limit")).toBe(CATALOG_READ_LIMIT);
  });
});

describe("datasets.listDraftSummaries", () => {
  it("filters lifecycle = draft server-side (creator scoping rides RLS)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await runQueryOptions(listDraftSummariesQueryOptions({ supabase: client }));
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["lifecycle", "draft"]);
  });
});

describe("datasets.listByCreator — the profile page's per-creator listing", () => {
  it("selects the summary projection filtered to created_by, newest first", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [datasetWire("d1")],
      error: null,
    }));
    const rows = await runQueryOptions(
      listByCreatorQueryOptions({ createdBy: "user-1" }, { supabase: client }),
    );
    expect(rows[0]).toMatchObject({ id: "d1", createdBy: "user-1" });
    const first = queryAt(queries, 0);
    expect(argsOf(first, "eq")).toStrictEqual(["created_by", "user-1"]);
    expect(String(firstArg(first, "select"))).not.toContain("jsonSchema");
    expect(allArgs(first, "order")).toStrictEqual([["created_at", { ascending: false }]]);
    expect(firstArg(first, "limit")).toBe(CATALOG_READ_LIMIT);
  });
});

describe("datasets.list / get", () => {
  it("list selects the FULL row (the heavy payload included)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await runQueryOptions(listQueryOptions({ supabase: client }));
    expect(String(firstArg(queryAt(queries, 0), "select"))).toContain("jsonSchema:json_schema");
  });

  it("get returns null when RLS hides the row (the not-found denial shape)", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: null }));
    const options = getQueryOptions({ datasetId: "d1" }, { supabase: client });
    expect(options.queryKey).toStrictEqual(["pg:datasets", "get", { datasetId: "d1" }]);
    await expect(runQueryOptions(options)).resolves.toBe(null);
  });
});

describe("datasets.maxTileCacheVersion", () => {
  it("reads the top version row and answers 0 on an empty catalog", async () => {
    const { client, queries, respond } = stubSupabase();
    const options = maxTileCacheVersionQueryOptions({ supabase: client });
    respond(() => ({ data: [{ mapTileCacheVersion: 12 }], error: null }));
    await expect(runQueryOptions(options)).resolves.toBe(12);
    expect(firstArg(queryAt(queries, 0), "limit")).toBe(1);
    respond(() => ({ data: null, error: null }));
    await expect(
      runQueryOptions(maxTileCacheVersionQueryOptions({ supabase: client })),
    ).resolves.toBe(0);
  });
});

describe("datasets.create", () => {
  it("folds title/description out of the schema and derives the declared properties", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "new-1" }, error: null }));
    const id = await create(
      {
        kind: "geospatial",
        schema: {
          description: "Grant sites",
          properties: { grant: { type: "string" }, site: { type: "string" } },
          title: "Grants",
          type: "object",
        },
      },
      { supabase: client },
    );
    expect(id).toBe("new-1");
    expect(queries.length).toBe(1);
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({
      description: "Grant sites",
      geometry_type: null,
      is_geospatial: true,
      json_schema: {
        description: "Grant sites",
        properties: { grant: { type: "string" }, site: { type: "string" } },
        title: "Grants",
        type: "object",
      },
      lifecycle: "published",
      properties: ["grant", "site"],
      visibility: "signed-in",
      simplify_geometry: false,
      title: "Grants",
      // `source` is absent for ordinary creates (host-flow-only); `lineage`
      // is not even an argument — the INSERT policy can never admit it.
    });
  });

  it("rejects the two malformed-schema shapes with the component's messages", async () => {
    const { client, queries } = stubSupabase();
    await expect(
      create({ schema: "nope" as unknown as Record<string, unknown> }, { supabase: client }),
    ).rejects.toThrowError("Schema must be an object with a non-empty 'title' property.");
    await expect(create({ schema: { type: "object" } }, { supabase: client })).rejects.toThrowError(
      "Schema must have a non-empty 'title' property",
    );
    expect(queries.length).toBe(0);
  });

  it("surfaces a PostgREST denial as one thrown error", async () => {
    const { client } = stubSupabase(() => ({
      data: null,
      error: postgrestError("new row violates row-level security policy"),
    }));
    await expect(
      create({ schema: { title: "Locked target" } }, { supabase: client }),
    ).rejects.toThrowError("new row violates row-level security policy (42501)");
  });
});

describe("datasets.update", () => {
  it("replaces the schema and re-derives title/description/properties from the payload", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "d1" }], error: null }));
    await update(
      {
        datasetId: "d1",
        schema: { description: "next", properties: { a: {} }, title: "Renamed" },
      },
      { supabase: client },
    );
    const first = queryAt(queries, 0);
    expect(firstArg(first, "update")).toStrictEqual({
      description: "next",
      json_schema: { description: "next", properties: { a: {} }, title: "Renamed" },
      properties: ["a"],
      title: "Renamed",
    });
    expect(argsOf(first, "eq")).toStrictEqual(["id", "d1"]);
  });

  it("metadata-only edits leave the schema and properties untouched", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "d1" }], error: null }));
    await update({ datasetId: "d1", title: "Just renamed" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ title: "Just renamed" });
  });
});

describe("datasets policy + lifecycle writes", () => {
  it("setEditPolicy / setVisibility / markImportComplete write exactly their column", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "d1" }], error: null }));
    await setEditPolicy({ datasetId: "d1", editPolicy: "locked" }, { supabase: client });
    await setVisibility({ datasetId: "d1", visibility: "members" }, { supabase: client });
    await markImportComplete({ datasetId: "d1" }, { supabase: client });
    const patches = queries.map((query) => firstArg(query, "update"));
    expect(patches).toStrictEqual([
      { edit_policy: "locked" },
      { visibility: "members" },
      { lifecycle: "published" },
    ]);
  });

  it("remove deletes by id (after the dependent-views pre-check)", async () => {
    const { client, queries } = stubSupabase((query) =>
      query.table === "view_inputs"
        ? { data: [], error: null }
        : { data: [{ id: "d1" }], error: null },
    );
    await remove({ datasetId: "d1" }, { supabase: client });
    expect(queryAt(queries, 0).table).toBe("view_inputs");
    const second = queryAt(queries, 1);
    expect(methodList(second)[0]).toBe("delete");
    expect(argsOf(second, "eq")).toStrictEqual(["id", "d1"]);
  });

  it("remove refuses a dataset a view still reads and names the views", async () => {
    const { client, queries } = stubSupabase((query) =>
      query.table === "view_inputs"
        ? {
            data: [{ view: { title: "Deployments per state" } }, { view: { title: "Links" } }],
            error: null,
          }
        : { data: [{ id: "d1" }], error: null },
    );
    await expect(remove({ datasetId: "d1" }, { supabase: client })).rejects.toThrow(
      /Deployments per state, Links/,
    );
    // The delete never ran.
    expect(queries.length).toBe(1);
  });
});

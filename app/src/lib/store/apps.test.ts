// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  APP_LIMITS,
  create,
  duplicate,
  firstPage,
  get,
  getQueryOptions,
  list,
  listExamples,
  listExamplesQueryOptions,
  listQueryOptions,
  MAX_APPS,
  remove,
  saveContent,
  toSummary,
  updateDetails,
  type AppContent,
  type AppPageConfig,
  type AppRow,
  type AppWidgetConfig,
} from "./apps";
import {
  allArgs,
  argsOf,
  firstArg,
  methodList,
  postgrestError,
  queryAt,
  stubSupabase,
  type QueryResponder,
  type StubSupabase,
} from "./test-support";

/** Pre-aliased (camelCase) — the stub skips PostgREST's `select` aliases, so fixtures arrive in the aliased shape the real service hands back. */
function appRow(id: string, overrides: Record<string, unknown> = {}): AppRow {
  return {
    createdAt: "2026-11-04T00:00:00Z",
    createdBy: "11111111-1111-1111-1111-111111111111",
    datasetIds: [],
    description: null,
    example: false,
    id,
    ownerName: null,
    pages: [firstPage()],
    revision: 0,
    sharing: "private",
    title: `App ${id}`,
    updatedAt: "2026-11-04T00:00:00Z",
    ...overrides,
  };
}

/** A one-widget page fixture (a stat widget keyed to a dataset). */
function statPage(widgetDatasetId: string): AppPageConfig {
  return {
    id: "overview",
    layout: "contained",
    title: "Overview",
    widgets: [
      { datasetId: widgetDatasetId, h: 2, id: "stat-1", kind: "stat", w: 4 },
      { datasetIds: [widgetDatasetId], h: 6, id: "map-1", kind: "map", w: 8 },
    ],
  };
}

/** `0..n-1` ids/indices for bound-violation fixtures. */
function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** A valid stat widget with overridable bounds (the refusal fixtures' base). */
function widgetOf(
  id: string,
  datasetId: string,
  overrides: Record<string, unknown> = {},
): AppWidgetConfig {
  return { datasetId, h: 2, id, kind: "stat", w: 4, ...overrides };
}

/**
 * Scripts one responder per upcoming query, in order — the shared stub's
 * `respond` only keeps the LAST responder, and multi-query writes (duplicate)
 * fire several queries inside one store call.
 */
function script(stub: StubSupabase, responders: QueryResponder[]): void {
  let index = 0;
  stub.respond((query) => {
    const responder = responders[index];
    index += 1;
    if (responder === undefined) {
      throw new Error(`No scripted responder for query ${index}.`);
    }
    return responder(query);
  });
}

describe("apps.list / apps.listExamples — the /apps browser and gallery", () => {
  it("selects the creator's apps server-side, newest first (issue #220; capped at MAX_APPS)", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [appRow("a2", { createdAt: "2026-11-04T01:00:00Z" }), appRow("a1")],
      error: null,
    }));
    const rows = await list({ createdBy: "user-1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("apps");
    expect(allArgs(query, "eq")[0]).toStrictEqual(["created_by", "user-1"]);
    expect(firstArg(query, "order")).toBe("created_at");
    expect(argsOf(query, "order")[1]).toStrictEqual({ ascending: false });
    expect(allArgs(query, "limit")[0]).toStrictEqual([MAX_APPS]);
    expect(rows[0]).toMatchObject({ id: "a2" });
  });

  it("listExamples filters example rows, oldest first (the Convex listExamples order)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await listExamples({ supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("apps");
    expect(allArgs(query, "eq")[0]).toStrictEqual(["example", true]);
    expect(argsOf(query, "order")[1]).toStrictEqual({ ascending: true });
    // The tiebreaker: identical created_at stamps (the seed writes both
    // examples in one statement) order by id, never by insertion chance.
    expect(allArgs(query, "order")[1]).toStrictEqual(["id", { ascending: true }]);
  });

  it("queryOptions carry the store namespace and args in the key", () => {
    const { client } = stubSupabase();
    const listArgs = { createdBy: "user-1" };
    expect(listQueryOptions(listArgs, { supabase: client }).queryKey).toStrictEqual([
      "pg:apps",
      "list",
      listArgs,
    ]);
    expect(listExamplesQueryOptions({ supabase: client }).queryKey).toStrictEqual([
      "pg:apps",
      "listExamples",
    ]);
    const args = { appId: "a1" };
    expect(getQueryOptions(args, { supabase: client }).queryKey).toStrictEqual([
      "pg:apps",
      "get",
      args,
    ]);
  });

  it("throws the PostgREST error shape on failure", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: postgrestError() }));
    await expect(list({ createdBy: "user-1" }, { supabase: client })).rejects.toThrow(
      "permission denied (42501)",
    );
  });
});

describe("apps.get — the viewer/builder read", () => {
  it("filters by id and embeds the owner's name (the profiles projection)", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [appRow("a1", { ownerName: "Ada" })],
      error: null,
    }));
    const row = await get({ appId: "a1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("apps");
    expect(firstArg(query, "eq")).toBe("id");
    expect(argsOf(query, "eq")[1]).toBe("a1");
    expect(firstArg(query, "select")).toContain("ownerName:profiles(name)");
    expect(row).not.toBeNull();
    expect(row === null ? "" : row.ownerName).toBe("Ada");
  });

  it("answers null when the row is missing (reads as not found)", async () => {
    const { client } = stubSupabase(() => ({ data: [], error: null }));
    expect(await get({ appId: "gone" }, { supabase: client })).toBeNull();
  });
});

describe("toSummary — the list-card projection", () => {
  it("derives the dataset/page/widget counts from the row", () => {
    const row = appRow("a1", {
      datasetIds: ["d1", "d2"],
      pages: [statPage("d1"), { ...statPage("d2"), widgets: statPage("d2").widgets.slice(0, 1) }],
    });
    expect(toSummary(row)).toStrictEqual({
      datasetCount: 2,
      description: null,
      example: false,
      id: "a1",
      pageCount: 2,
      sharing: "private",
      title: "App a1",
      updatedAt: "2026-11-04T00:00:00Z",
      widgetCount: 3,
    });
  });
});

describe("apps writes — rows-affected returns", () => {
  it("create inserts title/cleaned description/first page and returns the row", async () => {
    const { client, queries } = stubSupabase(() => ({ data: appRow("a-new"), error: null }));
    const row = await create({ description: "  d  ", title: "  Corridor  " }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("apps");
    expect(firstArg(query, "insert")).toStrictEqual({
      description: "d",
      pages: [firstPage()],
      title: "Corridor",
    });
    expect(methodList(query)).toStrictEqual(["insert", "select", "single"]);
    expect(row).toMatchObject({ id: "a-new" });
  });

  it("create rejects an empty title (the component's rule)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: null, error: null }));
    await expect(create({ title: "   " }, { supabase: client })).rejects.toThrow(
      "Give the app a title.",
    );
    expect(queries.length).toBe(0);
  });

  it("create rejects an over-long description before any query", async () => {
    const { client, queries } = stubSupabase();
    await expect(
      create(
        { description: "x".repeat(APP_LIMITS.description + 1), title: "t" },
        { supabase: client },
      ),
    ).rejects.toThrow("Keep the description under");
    expect(queries.length).toBe(0);
  });

  it("updateDetails patches only the given fields and returns the affected count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "a1" }], error: null }));
    const affected = await updateDetails(
      { appId: "a1", sharing: "link", title: "Renamed" },
      { supabase: client },
    );
    const query = queryAt(queries, 0);
    const payload = firstArg(query, "update") as Record<string, unknown>;
    expect(payload["title"]).toBe("Renamed");
    expect(payload["sharing"]).toBe("link");
    expect("description" in payload).toBe(false);
    expect("pages" in payload).toBe(false);
    expect("revision" in payload).toBe(false);
    expect(typeof payload["updated_at"]).toBe("string");
    expect(firstArg(query, "eq")).toBe("id");
    expect(argsOf(query, "eq")[1]).toBe("a1");
    expect(affected).toBe(1);
  });

  it("updateDetails reports 0 on a denied write (the silent-denial shape)", async () => {
    const { client } = stubSupabase(() => ({ data: [], error: null }));
    expect(await updateDetails({ appId: "foreign", title: "x" }, { supabase: client })).toBe(0);
  });

  it("updateDetails refuses an empty patch", async () => {
    const { client, queries } = stubSupabase();
    await expect(updateDetails({ appId: "a1" }, { supabase: client })).rejects.toThrow(
      "App update needs a field to set.",
    );
    expect(queries.length).toBe(0);
  });

  it("saveContent writes content + revision+1 gated on the expected revision", async () => {
    const stub = stubSupabase();
    script(stub, [
      // 1: the current-sources read (added-only visibility needs it).
      () => ({ data: [{ datasetIds: ["d1"] }], error: null }),
      // 2: the conditional update — all sources already in the app, so the
      // visibility read is skipped.
      () => ({ data: [{ revision: 7 }], error: null }),
    ]);
    const revision = await saveContent(
      {
        appId: "a1",
        content: { datasetIds: ["d1"], pages: [statPage("d1")] },
        expectedRevision: 6,
      },
      { supabase: stub.client },
    );
    const sourcesRead = queryAt(stub.queries, 0);
    expect(sourcesRead.table).toBe("apps");
    expect(firstArg(sourcesRead, "select")).toContain("datasetIds:dataset_ids");
    expect(argsOf(sourcesRead, "eq")[1]).toBe("a1");
    expect(stub.queries.length).toBe(2);
    const query = queryAt(stub.queries, 1);
    const payload = firstArg(query, "update") as Record<string, unknown>;
    expect(payload["dataset_ids"]).toStrictEqual(["d1"]);
    expect(payload["pages"]).toStrictEqual([statPage("d1")]);
    expect(payload["revision"]).toBe(7);
    expect(allArgs(query, "eq")[0]).toStrictEqual(["id", "a1"]);
    expect(allArgs(query, "eq")[1]).toStrictEqual(["revision", 6]);
    expect(revision).toBe(7);
  });

  it("saveContent throws the stale-save error when 0 rows matched", async () => {
    const stub = stubSupabase();
    script(stub, [
      () => ({ data: [{ datasetIds: [] }], error: null }),
      () => ({ data: [], error: null }),
    ]);
    await expect(
      saveContent(
        { appId: "a1", content: { datasetIds: [], pages: [firstPage()] }, expectedRevision: 6 },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("changed in another tab or window");
  });

  it("saveContent refuses a pages-less content before any query", async () => {
    const { queries } = stubSupabase();
    await expect(
      saveContent({ appId: "a1", content: { datasetIds: [], pages: [] }, expectedRevision: 0 }),
    ).rejects.toThrow("An app has 1 to 12 pages.");
    expect(queries.length).toBe(0);
  });

  it("saveContent refuses added sources that are invisible or deleted (Dataset not found.)", async () => {
    const stub = stubSupabase();
    script(stub, [
      // 1: the app currently holds no sources — both ids are additions.
      () => ({ data: [{ datasetIds: [] }], error: null }),
      // 2: the visibility read answers only the visible id under RLS.
      () => ({ data: [{ id: "d1" }], error: null }),
    ]);
    await expect(
      saveContent(
        {
          appId: "a1",
          content: { datasetIds: ["d1", "d-gone"], pages: [statPage("d1")] },
          expectedRevision: 6,
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("Dataset not found.");
    expect(queryAt(stub.queries, 1).table).toBe("datasets");
    expect(allArgs(queryAt(stub.queries, 1), "in")[0]).toStrictEqual(["id", ["d1", "d-gone"]]);
    // The write never fired.
    expect(stub.queries.length).toBe(2);
  });

  it("saveContent keeps sources already in the app even when they have since gone away", async () => {
    const stub = stubSupabase();
    script(stub, [
      // 1: the app already carries the deleted dataset — no addition, no
      // visibility read (the kept-datasets parity).
      () => ({ data: [{ datasetIds: ["d-gone"] }], error: null }),
      // 2: the conditional update succeeds.
      () => ({ data: [{ revision: 7 }], error: null }),
    ]);
    const revision = await saveContent(
      {
        appId: "a1",
        content: { datasetIds: ["d-gone"], pages: [firstPage()] },
        expectedRevision: 6,
      },
      { supabase: stub.client },
    );
    expect(stub.queries.length).toBe(2);
    expect(queryAt(stub.queries, 1).table).toBe("apps");
    expect(revision).toBe(7);
  });

  /** A valid save payload; each refusal case perturbs exactly one field. */
  function validContent(): AppContent {
    return { datasetIds: ["d1"], pages: [statPage("d1")] };
  }

  const refusedShapes: Array<[string, AppContent, string]> = [
    [
      "too many datasets",
      { ...validContent(), datasetIds: Array.from({ length: 21 }, (_, i) => `d${i}`) },
      "An app holds at most 20 datasets.",
    ],
    [
      "a dataset listed twice",
      { ...validContent(), datasetIds: ["d1", "d1"] },
      "A dataset is listed twice.",
    ],
    [
      "too many pages",
      { ...validContent(), pages: range(13).map(() => firstPage()) },
      "An app has 1 to 12 pages.",
    ],
    [
      "two pages sharing an id",
      { ...validContent(), pages: [firstPage(), firstPage()] },
      "Two pages share an id.",
    ],
    [
      "two widgets sharing an id",
      {
        ...validContent(),
        pages: [statPage("d1"), { ...statPage("d1"), id: "page-2" }],
      },
      "Two widgets share an id.",
    ],
    [
      "a page without a title",
      { ...validContent(), pages: [{ ...firstPage(), title: "   ", widgets: [] }] },
      "Give every page a title of up to 60 characters.",
    ],
    [
      "a page with an over-long title",
      { ...validContent(), pages: [{ ...firstPage(), title: "x".repeat(61), widgets: [] }] },
      "Give every page a title of up to 60 characters.",
    ],
    [
      "a page holding too many widgets",
      {
        ...validContent(),
        pages: [{ ...firstPage(), widgets: range(41).map((i) => widgetOf(`w${i}`, "d1")) }],
      },
      "A page holds at most 40 widgets.",
    ],
    [
      "a widget wider than the grid",
      {
        ...validContent(),
        pages: [{ ...firstPage(), widgets: [widgetOf("w1", "d1", { w: 13 })] }],
      },
      "A widget's width must be a whole number from 1 to 12.",
    ],
    [
      "a widget taller than the grid",
      {
        ...validContent(),
        pages: [{ ...firstPage(), widgets: [widgetOf("w1", "d1", { h: 0 })] }],
      },
      "A widget's height must be a whole number from 1 to 12.",
    ],
    [
      "a widget with an over-long title",
      {
        ...validContent(),
        pages: [{ ...firstPage(), widgets: [widgetOf("w1", "d1", { title: "x".repeat(121) })] }],
      },
      "Keep widget titles under 120 characters.",
    ],
    [
      "an over-long text block",
      {
        ...validContent(),
        pages: [
          {
            ...firstPage(),
            widgets: [
              { kind: "text", h: 2, id: "t1", w: 4, body: "x".repeat(APP_LIMITS.text + 1) },
            ],
          },
        ],
      },
      "Keep text blocks under 10000 characters.",
    ],
    [
      "a map with too many layers",
      {
        ...validContent(),
        pages: [
          {
            ...firstPage(),
            widgets: [
              {
                kind: "map",
                h: 6,
                id: "m1",
                w: 8,
                datasetIds: range(9).map((i) => `d${i}`),
              },
            ],
          },
        ],
      },
      "A map shows at most 8 datasets.",
    ],
    [
      "a table with too many columns",
      {
        ...validContent(),
        pages: [
          {
            ...firstPage(),
            widgets: [
              {
                kind: "table",
                h: 6,
                id: "tb1",
                w: 8,
                columns: range(51).map((i) => `c${i}`),
                datasetId: "d1",
              },
            ],
          },
        ],
      },
      "A table shows at most 50 columns.",
    ],
    [
      "a chart group limit out of range",
      {
        ...validContent(),
        pages: [
          {
            ...firstPage(),
            widgets: [
              {
                aggregate: "count",
                chartType: "bar",
                datasetId: "d1",
                h: 6,
                id: "ch1",
                kind: "chart",
                limit: 51,
                sort: "value-desc",
                w: 8,
              },
            ],
          },
        ],
      },
      "A chart's group limit must be a whole number from 1 to 50.",
    ],
    [
      "a widget referencing a dataset outside the app's sources",
      {
        ...validContent(),
        pages: [{ ...firstPage(), widgets: [widgetOf("w1", "d-other")] }],
      },
      "A widget uses a dataset that isn't in this app — add it first.",
    ],
  ];

  it.each(refusedShapes)(
    "%s — refused with the Convex error, before any query",
    async (_name, content, message) => {
      const { client, queries } = stubSupabase();
      await expect(
        saveContent({ appId: "a1", content, expectedRevision: 0 }, { supabase: client }),
      ).rejects.toThrow(message);
      expect(queries.length).toBe(0);
    },
  );

  it("remove deletes by id and returns the affected count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "a1" }], error: null }));
    expect(await remove({ appId: "a1" }, { supabase: client })).toBe(1);
    const query = queryAt(queries, 0);
    expect(methodList(query)[0]).toBe("delete");
    expect(argsOf(query, "eq")[1]).toBe("a1");
  });
});

describe("apps.duplicate — Make a copy (examples included)", () => {
  it("keeps only the datasets the new owner can see and drops unreferenced widgets", async () => {
    const stub = stubSupabase();
    script(stub, [
      // 1: the source read — one stat keyed to an INVISIBLE dataset, a map
      // keyed to a VISIBLE one.
      () => ({
        data: [
          appRow("src", {
            datasetIds: ["d-visible", "d-hidden"],
            pages: [statPage("d-visible"), statPage("d-hidden")],
          }),
        ],
        error: null,
      }),
      // 2: the visibility read — RLS answers the visible id only.
      () => ({ data: [{ id: "d-visible" }], error: null }),
      // 3: the copy insert.
      () => ({ data: appRow("copy"), error: null }),
    ]);
    const row = await duplicate({ appId: "src" }, { supabase: stub.client });
    const sourceRead = queryAt(stub.queries, 0);
    expect(sourceRead.table).toBe("apps");
    const visibilityRead = queryAt(stub.queries, 1);
    expect(visibilityRead.table).toBe("datasets");
    expect(allArgs(visibilityRead, "in")[0]).toStrictEqual(["id", ["d-visible", "d-hidden"]]);
    const insertQuery = queryAt(stub.queries, 2);
    const payload = firstArg(insertQuery, "insert") as Record<string, unknown>;
    expect(payload["title"]).toBe("App src (copy)");
    expect(payload["dataset_ids"]).toStrictEqual(["d-visible"]);
    const pages = payload["pages"] as AppPageConfig[];
    expect(pages).toHaveLength(2);
    const visiblePage = pages[0];
    expect(visiblePage === undefined ? null : visiblePage.widgets).toStrictEqual(
      statPage("d-visible").widgets,
    );
    // The second page's widgets all referenced the dropped dataset: the map
    // loses its layer list, the stat goes entirely.
    const droppedPage = pages[1];
    expect(droppedPage === undefined ? null : droppedPage.widgets[0]).toMatchObject({
      kind: "map",
      datasetIds: [],
    });
    expect(droppedPage === undefined ? null : droppedPage.widgets[1]).toBeUndefined();
    expect(row).toMatchObject({ id: "copy" });
  });

  it("answers null for an unreadable source without any further query", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    expect(await duplicate({ appId: "gone" }, { supabase: client })).toBeNull();
    expect(queries.length).toBe(1);
  });

  it("skips the visibility read when the source references no datasets", async () => {
    const stub = stubSupabase();
    script(stub, [
      () => ({ data: [appRow("src")], error: null }),
      () => ({ data: appRow("copy"), error: null }),
    ]);
    await duplicate({ appId: "src" }, { supabase: stub.client });
    expect(queryAt(stub.queries, 1).table).toBe("apps");
    expect(stub.queries.length).toBe(2);
  });
});

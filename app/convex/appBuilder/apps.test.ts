// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The app builder's access model and content rules (docs/app-builder.md),
 * driven through `api.appBuilder.apps.*` on a test backend with the json-cms
 * component mounted (the projects.test.ts setup).
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";
import type { Widget } from "./validators";

const modules = import.meta.glob("/convex/**/*.ts");

function initTest() {
  const t = convexTest(schema, modules);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the projects.test.ts cast: same instance, nominal-type-invariant across the helper.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

type Backend = ReturnType<typeof initTest>;

function as(t: Backend, subject: string) {
  return t.withIdentity({ subject });
}

type Caller = ReturnType<typeof as>;

async function createDataset(t: Caller, title = "Parks"): Promise<string> {
  return t.mutation(api.cms.schemas.create, {
    schema: { properties: { name: { type: "string" } }, title, type: "object" },
  });
}

/** One contained page holding `widgets` — the shape most tests save. */
function onePage(datasetIds: string[], widgets: Widget[]) {
  return {
    datasetIds,
    pages: [{ id: "p1", layout: "contained" as const, title: "Page 1", widgets }],
  };
}

function chart(datasetId: string, id = "w-chart"): Widget {
  return {
    aggregate: "count",
    chartType: "bar",
    datasetId,
    groupBy: "name",
    h: 4,
    id,
    kind: "chart",
    limit: 10,
    sort: "value-desc",
    w: 6,
  };
}

describe("app builder access", () => {
  it("rejects signed-out callers", async () => {
    const t = initTest();
    await expect(t.query(api.appBuilder.apps.list, {})).rejects.toThrow(/signed out/i);
  });

  it("keeps private apps to their creator and opens link-shared apps to any signed-in user", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      other = as(t, "other"),
      appId = await owner.mutation(api.appBuilder.apps.create, { title: "Parks explorer" });

    const own = await owner.query(api.appBuilder.apps.get, { appId });
    expect(own).toMatchObject({ canEdit: true, sharing: "private", title: "Parks explorer" });
    expect(await other.query(api.appBuilder.apps.get, { appId })).toBeNull();

    await owner.mutation(api.appBuilder.apps.updateDetails, { appId, sharing: "link" });
    expect(await other.query(api.appBuilder.apps.get, { appId })).toMatchObject({
      canEdit: false,
    });
    // Viewing is not editing.
    await expect(
      other.mutation(api.appBuilder.apps.updateDetails, { appId, title: "Mine now" }),
    ).rejects.toThrow(/not found/i);
    await expect(other.mutation(api.appBuilder.apps.remove, { appId })).rejects.toThrow(
      /not found/i,
    );
    expect(await other.query(api.appBuilder.apps.list, {})).toEqual([]);
  });

  it("answers null for malformed share ids", async () => {
    const owner = as(initTest(), "owner");
    expect(await owner.query(api.appBuilder.apps.get, { appId: "not-an-id" })).toBeNull();
  });
});

describe("app builder content", () => {
  it("saves datasets and widgets with optimistic revisions", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      datasetId = await createDataset(owner),
      appId = await owner.mutation(api.appBuilder.apps.create, { title: "Parks" });

    const revision = await owner.mutation(api.appBuilder.apps.saveContent, {
      appId,
      content: onePage([datasetId], [chart(datasetId)]),
      expectedRevision: 0,
    });
    expect(revision).toBe(1);
    const app = await owner.query(api.appBuilder.apps.get, { appId });
    expect(app).toMatchObject({ datasetIds: [datasetId], revision: 1 });

    // A stale editor tab is refused, not silently applied.
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: onePage([], []),
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/another tab/i);
  });

  it("refuses widgets that reference datasets outside the app, and bad sizes", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      datasetId = await createDataset(owner),
      appId = await owner.mutation(api.appBuilder.apps.create, { title: "Parks" });

    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: onePage([], [chart(datasetId)]),
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/isn't in this app/i);
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: onePage([datasetId], [{ ...chart(datasetId), w: 13 }]),
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/width/i);
  });

  it("never writes an invisible dataset id into an app", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      other = as(t, "other"),
      privateId = await createDataset(other, "Other's data");
    await other.mutation(api.cms.schemas.setVisibility, {
      schemaId: privateId,
      visibility: "author",
    });
    const appId = await owner.mutation(api.appBuilder.apps.create, { title: "Parks" });
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: onePage([privateId], []),
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: onePage(["junk"], []),
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("duplicates a shared app as a private copy the caller owns", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      other = as(t, "other"),
      datasetId = await createDataset(owner),
      appId = await owner.mutation(api.appBuilder.apps.create, { title: "Parks" });
    await owner.mutation(api.appBuilder.apps.saveContent, {
      appId,
      content: onePage([datasetId], [chart(datasetId)]),
      expectedRevision: 0,
    });
    await expect(other.mutation(api.appBuilder.apps.duplicate, { appId })).rejects.toThrow(
      /not found/i,
    );
    await owner.mutation(api.appBuilder.apps.updateDetails, { appId, sharing: "link" });

    const copyId = await other.mutation(api.appBuilder.apps.duplicate, { appId });
    const copy = await other.query(api.appBuilder.apps.get, { appId: copyId });
    expect(copy).toMatchObject({
      canEdit: true,
      datasetIds: [datasetId],
      sharing: "private",
      title: "Parks (copy)",
    });
    expect(copy === null ? 0 : copy.pages[0].widgets.length).toBe(1);
  });
});

describe("app builder pages", () => {
  it("saves several pages with their own layouts", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      datasetId = await createDataset(owner),
      appId = await owner.mutation(api.appBuilder.apps.create, { title: "Atlas" });
    const created = await owner.query(api.appBuilder.apps.get, { appId });
    expect(created === null ? [] : created.pages.map((page) => page.title)).toEqual(["Page 1"]);

    await owner.mutation(api.appBuilder.apps.saveContent, {
      appId,
      content: {
        datasetIds: [datasetId],
        pages: [
          {
            id: "map",
            layout: "fullscreen",
            title: "Map",
            widgets: [{ datasetIds: [datasetId], h: 12, id: "m", kind: "map", w: 12 }],
          },
          { id: "dash", layout: "contained", title: "Dashboard", widgets: [chart(datasetId)] },
        ],
      },
      expectedRevision: 0,
    });
    const app = await owner.query(api.appBuilder.apps.get, { appId });
    expect(app === null ? [] : app.pages.map((page) => [page.title, page.layout])).toEqual([
      ["Map", "fullscreen"],
      ["Dashboard", "contained"],
    ]);
  });

  it("refuses an app with no pages, duplicate ids, or blank page titles", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      datasetId = await createDataset(owner),
      appId = await owner.mutation(api.appBuilder.apps.create, { title: "Atlas" }),
      save = async (pages: ReturnType<typeof onePage>["pages"]) =>
        owner.mutation(api.appBuilder.apps.saveContent, {
          appId,
          content: { datasetIds: [datasetId], pages },
          expectedRevision: 0,
        });
    await expect(save([])).rejects.toThrow(/1 to/i);
    const page = onePage([datasetId], [chart(datasetId)]).pages[0];
    await expect(save([page, { ...page, widgets: [] }])).rejects.toThrow(/two pages/i);
    await expect(save([page, { ...page, id: "p2", widgets: [chart(datasetId)] }])).rejects.toThrow(
      /two widgets/i,
    );
    await expect(save([{ ...page, title: "  " }])).rejects.toThrow(/title/i);
  });

  it("reads a pre-pages app as one contained page", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      appId = await t.run(async (ctx) =>
        ctx.db.insert("apps", {
          createdBy: "owner",
          datasetIds: [],
          revision: 0,
          sharing: "private",
          title: "Legacy",
          updatedAt: 0,
          widgets: [{ body: "# Hi", h: 2, id: "t", kind: "text", w: 12 }],
        }),
      );
    const app = await owner.query(api.appBuilder.apps.get, { appId });
    expect(app === null ? undefined : app.pages).toEqual([
      {
        id: "page-1",
        layout: "contained",
        title: "Page 1",
        widgets: [{ body: "# Hi", h: 2, id: "t", kind: "text", w: 12 }],
      },
    ]);
  });
});

describe("example apps", () => {
  it("seeds once, opens to everyone, edits for no one, and copies", async () => {
    const t = initTest(),
      viewer = as(t, "viewer");
    const first = await t.mutation(internal.appBuilder.examples.seed, {});
    expect(first.created).toBe(true);
    expect(first.examples).toHaveLength(2);
    expect((await t.mutation(internal.appBuilder.examples.seed, {})).created).toBe(false);
    // A replace rebuilds the apps on the same sample datasets.
    const replaced = await t.mutation(internal.appBuilder.examples.seed, { replace: true });
    expect(replaced.created).toBe(true);
    const datasetsAfter = await t.run(async (ctx) =>
      Promise.all(
        replaced.examples.map(async (id) => {
          const app = await ctx.db.get("apps", id);
          return app === null ? undefined : app.datasetIds;
        }),
      ),
    );
    expect(datasetsAfter[0]).toEqual(datasetsAfter[1]);

    const examples = await viewer.query(api.appBuilder.apps.listExamples, {});
    expect(examples.map((app) => app.title)).toEqual([
      "National Parks Explorer",
      "Park Visits Atlas",
    ]);
    const atlasId = replaced.examples[1],
      atlas = await viewer.query(api.appBuilder.apps.get, { appId: atlasId });
    expect(atlas).toMatchObject({ canEdit: false, example: true });
    expect(atlas === null ? [] : atlas.pages.map((page) => page.layout)).toEqual([
      "fullscreen",
      "contained",
    ]);
    // Examples are not anyone's own apps, and nobody edits them.
    expect(await viewer.query(api.appBuilder.apps.list, {})).toEqual([]);
    await expect(
      viewer.mutation(api.appBuilder.apps.updateDetails, { appId: atlasId, title: "Mine" }),
    ).rejects.toThrow(/not found/i);

    // The sample datasets are catalog-visible and locked.
    const datasetIds = atlas === null ? [] : atlas.datasetIds;
    const parks = await viewer.query(api.cms.schemas.get, { schemaId: datasetIds[0] });
    expect(parks).toMatchObject({ editPolicy: "locked", entryCount: 28 });

    const copyId = await viewer.mutation(api.appBuilder.apps.duplicate, { appId: atlasId }),
      copy = await viewer.query(api.appBuilder.apps.get, { appId: copyId });
    expect(copy).toMatchObject({ canEdit: true, example: false, sharing: "private" });
    expect(copy === null ? 0 : copy.pages.length).toBe(2);
  });
});

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

import { api } from "../_generated/api";
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
  return t.mutation(api.schemas.create, {
    schema: { properties: { name: { type: "string" } }, title, type: "object" },
  });
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
      content: { datasetIds: [datasetId], widgets: [chart(datasetId)] },
      expectedRevision: 0,
    });
    expect(revision).toBe(1);
    const app = await owner.query(api.appBuilder.apps.get, { appId });
    expect(app).toMatchObject({ datasetIds: [datasetId], revision: 1 });

    // A stale editor tab is refused, not silently applied.
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: { datasetIds: [], widgets: [] },
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
        content: { datasetIds: [], widgets: [chart(datasetId)] },
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/isn't in this app/i);
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: { datasetIds: [datasetId], widgets: [{ ...chart(datasetId), w: 13 }] },
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/width/i);
  });

  it("never writes an invisible dataset id into an app", async () => {
    const t = initTest(),
      owner = as(t, "owner"),
      other = as(t, "other"),
      privateId = await createDataset(other, "Other's data");
    await other.mutation(api.schemas.setVisibility, {
      schemaId: privateId,
      visibility: "author",
    });
    const appId = await owner.mutation(api.appBuilder.apps.create, { title: "Parks" });
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: { datasetIds: [privateId], widgets: [] },
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      owner.mutation(api.appBuilder.apps.saveContent, {
        appId,
        content: { datasetIds: ["junk"], widgets: [] },
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
      content: { datasetIds: [datasetId], widgets: [chart(datasetId)] },
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
    expect(copy === null ? 0 : copy.widgets.length).toBe(1);
  });
});

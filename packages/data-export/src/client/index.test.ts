/// <reference types="vite/client" />

import {
  anyApi,
  defineSchema,
  defineTable,
  mutationGeneric,
  type ApiFromModules,
} from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";

import { exportReader, exposeApi, type ReaderReference } from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

const schema = defineSchema({
  things: defineTable({ name: v.string() }),
});

// A tiny host mutation to seed data for the tests.
export const seedThing = mutationGeneric({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("things", { name: args.name });
  },
});

// Register a host reader and an authenticated API, as a consuming app would.
export const readTablePage = exportReader();
export const { startExport, listExports, getExport } = exposeApi(components.dataExport, {
  reader: (anyApi as unknown as { "index.test": { readTablePage: unknown } })["index.test"]
    .readTablePage as ReaderReference,
  auth: async () => "user1",
});

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      seedThing: typeof seedThing;
      readTablePage: typeof readTablePage;
      startExport: typeof startExport;
      listExports: typeof listExports;
      getExport: typeof getExport;
    };
  }>
)["index.test"];

describe("client API", () => {
  test("the reader pages a host table by name", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.seedThing, { name: "a" });
    await t.mutation(testApi.seedThing, { name: "b" });

    const page = await t.query(testApi.readTablePage, {
      table: "things",
      cursor: null,
      numItems: 1,
    });
    expect(page.page).toHaveLength(1);
    expect(page.isDone).toBe(false);
  });

  test("exposeApi.startExport creates a running snapshot", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.seedThing, { name: "a" });

    const exportId = await t.mutation(testApi.startExport, {
      tableNames: ["things"],
    });
    const exp = await t.query(testApi.getExport, { exportId });
    if (!exp) throw new Error("expected export to exist");
    expect(exp.status).toBe("running");
    expect(exp.tableNames).toEqual(["things"]);

    const list = await t.query(testApi.listExports, {});
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});

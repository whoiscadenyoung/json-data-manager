import { describe, expect, test } from "vitest";
import { exposeApi } from "./index.js";
import { anyApi, type ApiFromModules } from "convex/server";
import { components, initConvexTest } from "./setup.test.js";

// Type for component table IDs
type SchemaId = string & { __tableName: "schemas" };

export const {
  listSchemas,
  getSchema,
  createSchema,
  createEntry,
  listEntries,
} = exposeApi(components.jsonCms, {
  auth: async (ctx, _operation) => {
    return (await ctx.auth.getUserIdentity())?.subject ?? "anonymous";
  },
});

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      listSchemas: typeof listSchemas;
      getSchema: typeof getSchema;
      createSchema: typeof createSchema;
      createEntry: typeof createEntry;
      listEntries: typeof listEntries;
    };
  }>
)["index.test"];

describe("client tests", () => {
  test("should be able to use client", async () => {
    const t = initConvexTest().withIdentity({
      subject: "user1",
    });

    const testSchema = {
      title: "Test Schema",
      description: "A test schema",
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    const schemaId = await t.mutation(testApi.createSchema, {
      schema: testSchema,
    }) as SchemaId;
    expect(schemaId).toBeDefined();

    const schemas = await t.query(testApi.listSchemas, {});
    expect(schemas).toHaveLength(1);
    expect(schemas[0].title).toBe("Test Schema");

    const entryId = await t.mutation(testApi.createEntry, {
      schemaId,
      data: { name: "John" },
    });
    expect(entryId).toBeDefined();

    const entries = await t.query(testApi.listEntries, { schemaId });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({ name: "John" });
  });
});

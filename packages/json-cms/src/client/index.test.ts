import { anyApi } from "convex/server";
import type { ApiFromModules } from "convex/server";
import { describe, expect, it } from "vitest";

import { exposeApi } from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

// Type for component table IDs
type SchemaId = string & { __tableName: "schemas" };

export const { listSchemas, getSchema, createSchema, createEntry, listEntries } = exposeApi(
  components.jsonCms,
  {
    auth: async (ctx, _operation) => {
      const identity = await ctx.auth.getUserIdentity();
      return identity ? identity.subject : "anonymous";
    },
  },
);

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
  it("should be able to use client", async () => {
    const t = initConvexTest().withIdentity({
        subject: "user1",
      }),
      testSchema = {
        description: "A test schema",
        properties: {
          name: { type: "string" },
        },
        title: "Test Schema",
        type: "object",
      },
      schemaId = (await t.mutation(testApi.createSchema, {
        schema: testSchema,
      })) as SchemaId;
    expect(schemaId).toBeDefined();

    const schemas = await t.query(testApi.listSchemas, {});
    expect(schemas).toHaveLength(1);
    expect(schemas[0].title).toBe("Test Schema");

    const entryId = await t.mutation(testApi.createEntry, {
      data: { name: "John" },
      schemaId,
    });
    expect(entryId).toBeDefined();

    const entries = await t.query(testApi.listEntries, { schemaId });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toStrictEqual({ name: "John" });
  });
});

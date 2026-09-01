import { it, afterEach, describe, expect, beforeEach, vi } from "vitest";

import { api } from "./_generated/api";
import { initConvexTest } from "./setup.test";

// Type for component table IDs
type SchemaId = string & { __tableName: "schemas" };

describe("example", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createSchema and listSchemas", async () => {
    const t = initConvexTest(),
      testSchema = {
        description: "A test schema",
        properties: {
          name: { type: "string" },
        },
        title: "Test Schema",
        type: "object",
      },
      schemaId = await t.mutation(api.example.createSchema, {
        schema: testSchema,
      });
    expect(schemaId).toBeDefined();

    const schemas = await t.query(api.example.listSchemas, {});
    expect(schemas).toHaveLength(1);
    expect(schemas[0].title).toBe("Test Schema");
    expect(schemas[0].description).toBe("A test schema");
  });

  it("createSchema and createEntry", async () => {
    const t = initConvexTest(),
      testSchema = {
        description: "A test schema",
        properties: {
          name: { type: "string" },
        },
        title: "Test Schema",
        type: "object",
      },
      schemaId = (await t.mutation(api.example.createSchema, {
        schema: testSchema,
      })) as SchemaId,
      entryId = await t.mutation(api.example.createEntry, {
        data: { name: "John" },
        schemaId,
      });
    expect(entryId).toBeDefined();

    const entries = await t.query(api.example.listEntries, { schemaId });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toStrictEqual({ name: "John" });
  });
});

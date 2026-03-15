import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

// Type for component table IDs
type SchemaId = string & { __tableName: "schemas" };

describe("example", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("createSchema and listSchemas", async () => {
    const t = initConvexTest();

    const testSchema = {
      title: "Test Schema",
      description: "A test schema",
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    const schemaId = await t.mutation(api.example.createSchema, {
      schema: testSchema,
    });
    expect(schemaId).toBeDefined();

    const schemas = await t.query(api.example.listSchemas, {});
    expect(schemas).toHaveLength(1);
    expect(schemas[0].title).toBe("Test Schema");
    expect(schemas[0].description).toBe("A test schema");
  });

  test("createSchema and createEntry", async () => {
    const t = initConvexTest();

    const testSchema = {
      title: "Test Schema",
      description: "A test schema",
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    const schemaId = await t.mutation(api.example.createSchema, {
      schema: testSchema,
    }) as SchemaId;

    const entryId = await t.mutation(api.example.createEntry, {
      schemaId,
      data: { name: "John" },
    });
    expect(entryId).toBeDefined();

    const entries = await t.query(api.example.listEntries, { schemaId });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({ name: "John" });
  });
});

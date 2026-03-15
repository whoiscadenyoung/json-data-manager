/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("json-cms component", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("schema operations", () => {
    test("create and list schemas", async () => {
      const t = initConvexTest();

      const testSchema = {
        title: "Test Schema",
        description: "A test schema",
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });
      expect(schemaId).toBeDefined();

      const schemas = await t.query(api.lib.listSchemas, {});
      expect(schemas).toHaveLength(1);
      expect(schemas[0].title).toEqual("Test Schema");
      expect(schemas[0].description).toEqual("A test schema");
    });

    test("get schema", async () => {
      const t = initConvexTest();

      const testSchema = {
        title: "Test Schema",
        description: "A test schema",
        type: "object",
      };

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema).toBeDefined();
      expect(schema?.title).toEqual("Test Schema");
      expect(schema?.description).toEqual("A test schema");
    });

    test("get schema returns null for non-existent", async () => {
      const t = initConvexTest();

      // Create a schema, get its ID, then delete it
      const testSchema = {
        title: "Temp Schema",
        description: "Will be deleted",
        type: "object",
      };
      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });
      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Now the ID should return null
      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema).toBeNull();
    });

    test("update schema with new schema object", async () => {
      const t = initConvexTest();

      const testSchema = {
        title: "Test Schema",
        description: "A test schema",
        type: "object",
      };

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });

      await t.mutation(api.lib.updateSchema, {
        schemaId,
        schema: {
          title: "Updated Schema",
          description: "An updated schema",
          type: "object",
        },
      });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema?.title).toEqual("Updated Schema");
      expect(schema?.description).toEqual("An updated schema");
    });

    test("update schema with only title/description", async () => {
      const t = initConvexTest();

      const testSchema = {
        title: "Test Schema",
        description: "A test schema",
        type: "object",
      };

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });

      await t.mutation(api.lib.updateSchema, {
        schemaId,
        title: "Updated Title",
      });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema?.title).toEqual("Updated Title");
      expect(schema?.description).toEqual("A test schema");
    });

    test("create schema without title throws error", async () => {
      const t = initConvexTest();

      const badSchema = {
        description: "A test schema",
        type: "object",
      };

      await expect(
        t.mutation(api.lib.createSchema, { schema: badSchema }),
      ).rejects.toThrow();
    });

    test("create schema without description throws error", async () => {
      const t = initConvexTest();

      const badSchema = {
        title: "Test Schema",
        type: "object",
      };

      await expect(
        t.mutation(api.lib.createSchema, { schema: badSchema }),
      ).rejects.toThrow();
    });

    test("update non-existent schema throws error", async () => {
      const t = initConvexTest();

      // Create a schema, get its ID, then delete it
      const testSchema = {
        title: "Temp Schema",
        description: "Will be deleted",
        type: "object",
      };
      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });
      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Now updating the deleted ID should throw
      await expect(
        t.mutation(api.lib.updateSchema, {
          schemaId,
          title: "New Title",
        }),
      ).rejects.toThrow("Schema not found");
    });

    test("delete schema removes schema and entries", async () => {
      const t = initConvexTest();

      const testSchema = {
        title: "Test Schema",
        description: "A test schema",
        type: "object",
      };

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });

      // Create an entry for this schema and remember its ID
      const entryId = await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "test" },
      });

      // Verify entry exists before deletion
      const entryBefore = await t.query(api.lib.getEntry, { entryId });
      expect(entryBefore).toBeDefined();

      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Schema should be deleted
      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema).toBeNull();

      // Entry should also be deleted (cascade delete)
      const entryAfter = await t.query(api.lib.getEntry, { entryId });
      expect(entryAfter).toBeNull();
    });

    test("delete non-existent schema throws error", async () => {
      const t = initConvexTest();

      // Create a schema, get its ID, then delete it
      const testSchema = {
        title: "Temp Schema",
        description: "Will be deleted",
        type: "object",
      };
      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });
      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Now deleting again should throw
      await expect(
        t.mutation(api.lib.deleteSchema, { schemaId }),
      ).rejects.toThrow("Schema not found");
    });
  });

  describe("entry operations", () => {
    async function createTestSchema(t: ReturnType<typeof initConvexTest>) {
      return await t.mutation(api.lib.createSchema, {
        schema: {
          title: "Test Schema",
          description: "A test schema",
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
        },
      });
    }

    test("create and list entries", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      const entryId = await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "John", age: 30 },
      });
      expect(entryId).toBeDefined();

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(1);
      expect(entries[0].data).toEqual({ name: "John", age: 30 });
      expect(entries[0].schemaId).toEqual(schemaId);
    });

    test("get entry", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      const entryId = await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "John" },
      });

      const entry = await t.query(api.lib.getEntry, { entryId });
      expect(entry).toBeDefined();
      expect(entry?.data).toEqual({ name: "John" });
    });

    test("get entry returns null for non-existent", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      // Create and delete an entry
      const entryId = await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "test" },
      });
      await t.mutation(api.lib.deleteEntry, { entryId });

      // Now the ID should return null
      const entry = await t.query(api.lib.getEntry, { entryId });
      expect(entry).toBeNull();
    });

    test("create entries in bulk", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      const ids = await t.mutation(api.lib.createEntriesBulk, {
        schemaId,
        dataArray: [{ name: "John" }, { name: "Jane" }, { name: "Bob" }],
      });
      expect(ids).toHaveLength(3);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(3);
    });

    test("update entry", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      const entryId = await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "John", age: 30 },
      });

      await t.mutation(api.lib.updateEntry, {
        entryId,
        data: { name: "John", age: 31 },
      });

      const entry = await t.query(api.lib.getEntry, { entryId });
      expect(entry?.data).toEqual({ name: "John", age: 31 });
    });

    test("delete entry", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      const entryId = await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "John" },
      });

      await t.mutation(api.lib.deleteEntry, { entryId });

      const entry = await t.query(api.lib.getEntry, { entryId });
      expect(entry).toBeNull();
    });

    test("delete entries by schema", async () => {
      const t = initConvexTest();
      const schemaId = await createTestSchema(t);

      await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "John" },
      });
      await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { name: "Jane" },
      });

      const count = await t.mutation(api.lib.deleteEntriesBySchema, {
        schemaId,
      });
      expect(count).toBe(2);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(0);
    });

  });

  describe("schema size limit", () => {
    test("schema exceeding 100KB throws error", async () => {
      const t = initConvexTest();

      // Create a large schema that exceeds 100KB
      const largeSchema = {
        title: "Large Schema",
        description: "A very large schema",
        type: "object",
        properties: {} as Record<string, any>,
      };

      // Add enough properties to exceed 100KB
      for (let i = 0; i < 5000; i++) {
        largeSchema.properties[`field${i}`] = {
          type: "string",
          description: `This is a very long description for field ${i} that will help us reach the 100KB limit faster by adding more characters to the JSON string`,
        };
      }

      await expect(
        t.mutation(api.lib.createSchema, { schema: largeSchema }),
      ).rejects.toThrow("Schema exceeds the 100 KB size limit");
    });

    test("update with schema exceeding 100KB throws error", async () => {
      const t = initConvexTest();

      const testSchema = {
        title: "Test Schema",
        description: "A test schema",
        type: "object",
      };

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: testSchema,
      });

      const largeSchema = {
        title: "Large Schema",
        description: "A very large schema",
        type: "object",
        properties: {} as Record<string, any>,
      };

      for (let i = 0; i < 5000; i++) {
        largeSchema.properties[`field${i}`] = {
          type: "string",
          description: `This is a very long description for field ${i} that will help us reach the 100KB limit faster by adding more characters to the JSON string`,
        };
      }

      await expect(
        t.mutation(api.lib.updateSchema, {
          schemaId,
          schema: largeSchema,
        }),
      ).rejects.toThrow("Schema exceeds the 100 KB size limit");
    });
  });

  describe("integration", () => {
    test("multiple schemas with entries are isolated", async () => {
      const t = initConvexTest();

      const schemaId1 = await t.mutation(api.lib.createSchema, {
        schema: {
          title: "Schema 1",
          description: "First schema",
          type: "object",
        },
      });

      const schemaId2 = await t.mutation(api.lib.createSchema, {
        schema: {
          title: "Schema 2",
          description: "Second schema",
          type: "object",
        },
      });

      await t.mutation(api.lib.createEntry, {
        schemaId: schemaId1,
        data: { source: "schema1" },
      });

      await t.mutation(api.lib.createEntry, {
        schemaId: schemaId2,
        data: { source: "schema2" },
      });

      const entries1 = await t.query(api.lib.listEntries, {
        schemaId: schemaId1,
      });
      const entries2 = await t.query(api.lib.listEntries, {
        schemaId: schemaId2,
      });

      expect(entries1).toHaveLength(1);
      expect(entries2).toHaveLength(1);
      expect(entries1[0].data.source).toEqual("schema1");
      expect(entries2[0].data.source).toEqual("schema2");
    });

    test("entries are ordered by creation time descending", async () => {
      const t = initConvexTest();

      const schemaId = await t.mutation(api.lib.createSchema, {
        schema: {
          title: "Test Schema",
          description: "A test schema",
          type: "object",
        },
      });

      // Create entries with timestamps
      await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { order: 1 },
      });

      vi.advanceTimersByTime(1000);

      await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { order: 2 },
      });

      vi.advanceTimersByTime(1000);

      await t.mutation(api.lib.createEntry, {
        schemaId,
        data: { order: 3 },
      });

      const entries = await t.query(api.lib.listEntries, { schemaId });

      // Should be in reverse order (newest first)
      expect(entries[0].data.order).toBe(3);
      expect(entries[1].data.order).toBe(2);
      expect(entries[2].data.order).toBe(1);
    });
  });
});

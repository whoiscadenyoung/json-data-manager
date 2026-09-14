import { it, afterEach, describe, expect, beforeEach, vi } from "vitest";
/// <reference types="vite/client" />

import type { GeometryArgs, GeometryTypeArg } from "../shared/geojson/validators.js";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

type TestCtx = ReturnType<typeof initConvexTest>;

function assertDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be defined");
  }
}

async function createTestSchema(t: TestCtx) {
  return t.mutation(api.lib.createSchema, {
    schema: {
      description: "A test schema",
      properties: {
        age: { type: "number" },
        name: { type: "string" },
      },
      title: "Test Schema",
      type: "object",
    },
  });
}

async function createImportSchema(t: TestCtx) {
  return t.mutation(api.lib.createSchema, {
    schema: {
      description: "For import tests",
      properties: { name: { type: "string" } },
      title: "Import Schema",
      type: "object",
    },
  });
}

async function storeRows(t: TestCtx, rows: unknown[]) {
  return t.run(async (ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(rows)], { type: "application/json" })),
  );
}

async function createGeospatialSchema(t: TestCtx, geometryType: GeometryTypeArg) {
  return t.mutation(api.lib.createSchema, {
    geometryType,
    kind: "geospatial",
    schema: {
      description: "A geospatial test schema",
      title: "Geospatial Schema",
      type: "object",
    },
  });
}

describe("json-cms component", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("schema operations", () => {
    it("create and list schemas", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          properties: {
            name: { type: "string" },
          },
          title: "Test Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        });
      expect(schemaId).toBeDefined();

      const schemas = await t.query(api.lib.listSchemas, {});
      expect(schemas).toHaveLength(1);
      expect(schemas[0].title).toBe("Test Schema");
      expect(schemas[0].description).toBe("A test schema");
    });

    it("get schema", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          title: "Test Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        }),
        schema = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schema);
      expect(schema.title).toBe("Test Schema");
      expect(schema.description).toBe("A test schema");
    });

    it("get schema returns null for non-existent", async () => {
      const t = initConvexTest(),
        // Create a schema, get its ID, then delete it
        testSchema = {
          description: "Will be deleted",
          title: "Temp Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        });
      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Now the ID should return null
      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema).toBeNull();
    });

    it("update schema with new schema object", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          title: "Test Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        });

      await t.mutation(api.lib.updateSchema, {
        schema: {
          description: "An updated schema",
          title: "Updated Schema",
          type: "object",
        },
        schemaId,
      });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schema);
      expect(schema.title).toBe("Updated Schema");
      expect(schema.description).toBe("An updated schema");
    });

    it("update schema with only title/description", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          title: "Test Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        });

      await t.mutation(api.lib.updateSchema, {
        schemaId,
        title: "Updated Title",
      });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schema);
      expect(schema.title).toBe("Updated Title");
      expect(schema.description).toBe("A test schema");
    });

    it("create and get schema with uiSchema", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          properties: {
            name: { type: "string" },
          },
          title: "Test Schema",
          type: "object",
        },
        testUiSchema = {
          name: { "ui:widget": "textarea" },
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
          uiSchema: testUiSchema,
        }),
        schema = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schema);
      expect(schema.uiSchema).toStrictEqual(testUiSchema);
    });

    it("update schema's uiSchema", async () => {
      const t = initConvexTest(),
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: {
            description: "A test schema",
            title: "Test Schema",
            type: "object",
          },
        }),
        uiSchema = { "ui:order": ["name", "age"] };
      await t.mutation(api.lib.updateSchema, {
        schemaId,
        uiSchema,
      });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schema);
      expect(schema.uiSchema).toStrictEqual(uiSchema);
      // Title/description untouched by a uiSchema-only update
      expect(schema.title).toBe("Test Schema");
    });

    it("create schema without title throws error", async () => {
      const t = initConvexTest(),
        badSchema = {
          description: "A test schema",
          type: "object",
        };

      await expect(t.mutation(api.lib.createSchema, { schema: badSchema })).rejects.toThrow(
        "Schema must have 'title' and 'description' properties",
      );
    });

    it("create schema without description throws error", async () => {
      const t = initConvexTest(),
        badSchema = {
          title: "Test Schema",
          type: "object",
        };

      await expect(t.mutation(api.lib.createSchema, { schema: badSchema })).rejects.toThrow(
        "Schema must have 'title' and 'description' properties",
      );
    });

    it("update non-existent schema throws error", async () => {
      const t = initConvexTest(),
        // Create a schema, get its ID, then delete it
        testSchema = {
          description: "Will be deleted",
          title: "Temp Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
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

    it("delete schema removes schema and entries", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          title: "Test Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        }),
        // Create an entry for this schema and remember its ID
        entryId = await t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          schemaId,
        }),
        // Verify entry exists before deletion
        entryBefore = await t.query(api.lib.getEntry, { entryId });
      expect(entryBefore).toBeDefined();

      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Schema should be deleted
      const schema = await t.query(api.lib.getSchema, { schemaId });
      expect(schema).toBeNull();

      // Entry should also be deleted (cascade delete)
      const entryAfter = await t.query(api.lib.getEntry, { entryId });
      expect(entryAfter).toBeNull();
    });

    it("delete non-existent schema throws error", async () => {
      const t = initConvexTest(),
        // Create a schema, get its ID, then delete it
        testSchema = {
          description: "Will be deleted",
          title: "Temp Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        });
      await t.mutation(api.lib.deleteSchema, { schemaId });

      // Now deleting again should throw
      await expect(t.mutation(api.lib.deleteSchema, { schemaId })).rejects.toThrow(
        "Schema not found",
      );
    });
  });

  describe("geospatial datasets", () => {
    const validPolygon: GeometryArgs = {
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        type: "Polygon",
      },
      validMultiPolygon: GeometryArgs = {
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
        type: "MultiPolygon",
      },
      invalidPoint: GeometryArgs = { coordinates: [200, 20], type: "Point" };

    it("createSchema with kind 'geospatial' but no geometryType throws", async () => {
      const t = initConvexTest();

      await expect(
        t.mutation(api.lib.createSchema, {
          kind: "geospatial",
          schema: {
            description: "A geospatial test schema",
            title: "Geospatial Schema",
            type: "object",
          },
        }),
      ).rejects.toThrow("A geospatial dataset must specify a geometryType.");
    });

    it("createSchema with kind 'geospatial' and geometryType 'Polygon' succeeds", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.kind).toBe("geospatial");
      expect(schemaDoc.geometryType).toBe("Polygon");
    });

    it("createEntry on a standard-kind schema with a geometry arg throws", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t);

      await expect(
        t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          geometry: validPolygon,
          schemaId,
        }),
      ).rejects.toThrow("Cannot attach geometry to a standard dataset.");
    });

    it("createEntry on a MultiPolygon-locked schema accepts a Polygon geometry (asymmetric compatibility)", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "MultiPolygon"),
        entryId = await t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          geometry: validPolygon,
          schemaId,
        }),
        entry = await t.query(api.lib.getEntry, { entryId });
      assertDefined(entry);
      // Stored as a pointer, not inline: `entries` never carries coordinates.
      expect(entry).not.toHaveProperty("geometry");
      expect(entry.geometryType).toBe("Polygon");
      assertDefined(entry.geometryId);

      // The real coordinates live only in `geometries`.
      const geometries = await t.query(api.lib.listGeometries, { schemaId }),
        geometryDoc = geometries.find((g) => g._id === entry.geometryId);
      assertDefined(geometryDoc);
      expect(geometryDoc.geometry).toStrictEqual(validPolygon);
      expect(geometryDoc.type).toBe("Polygon");
      expect(geometryDoc.entryId).toBe(entryId);
    });

    it("createEntry on a Polygon-locked schema rejects a MultiPolygon geometry (other direction of the asymmetry)", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon");

      await expect(
        t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          geometry: validMultiPolygon,
          schemaId,
        }),
      ).rejects.toThrow(
        'Geometry type "MultiPolygon" is not compatible with this dataset\'s "Polygon" geometry type.',
      );
    });

    it("createEntry on a geospatial schema with a structurally invalid geometry throws", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point");

      await expect(
        t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          geometry: invalidPoint,
          schemaId,
        }),
      ).rejects.toThrow("longitude must be a finite number in [-180, 180]");
    });

    it("featureCount/boundingBox track create -> update (replace) -> delete", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        pointA: GeometryArgs = { coordinates: [0, 0], type: "Point" },
        pointB: GeometryArgs = { coordinates: [10, 10], type: "Point" },
        pointC: GeometryArgs = { coordinates: [-5, -5], type: "Point" },
        entryId = await t.mutation(api.lib.createEntry, {
          data: {},
          geometry: pointA,
          schemaId,
        });

      let schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(1);
      expect(schemaDoc.boundingBox).toStrictEqual([0, 0, 0, 0]);

      // Replace the geometry with one further out: bbox grows, count is unchanged
      // (a replace, not an add), and the SAME `geometries` row is reused in place.
      await t.mutation(api.lib.updateEntry, { data: {}, entryId, geometry: pointB });

      schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(1);
      expect(schemaDoc.boundingBox).toStrictEqual([0, 0, 10, 10]);

      const geometriesAfterUpdate = await t.query(api.lib.listGeometries, { schemaId });
      expect(geometriesAfterUpdate).toHaveLength(1);
      expect(geometriesAfterUpdate[0].geometry).toStrictEqual(pointB);

      // A second entry elsewhere, to prove the bbox stays monotonic through a later delete.
      await t.mutation(api.lib.createEntry, { data: {}, geometry: pointC, schemaId });

      schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(2);
      expect(schemaDoc.boundingBox).toStrictEqual([-5, -5, 10, 10]);

      // Delete the first entry: featureCount decrements exactly; bbox does NOT
      // shrink back (monotonic-growth contract — see schema.ts).
      await t.mutation(api.lib.deleteEntry, { entryId });

      schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(1);
      expect(schemaDoc.boundingBox).toStrictEqual([-5, -5, 10, 10]);

      const geometriesAfterDelete = await t.query(api.lib.listGeometries, { schemaId });
      expect(geometriesAfterDelete).toHaveLength(1);
    });

    it("updateEntry with geometry: null explicitly clears geometry and decrements featureCount", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        entryId = await t.mutation(api.lib.createEntry, {
          data: {},
          geometry: { coordinates: [1, 1], type: "Point" },
          schemaId,
        });

      await t.mutation(api.lib.updateEntry, { data: {}, entryId, geometry: null });

      const entry = await t.query(api.lib.getEntry, { entryId });
      assertDefined(entry);
      expect(entry.geometryId).toBeUndefined();
      expect(entry.geometryType).toBeUndefined();

      const schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(0);

      const geometries = await t.query(api.lib.listGeometries, { schemaId });
      expect(geometries).toHaveLength(0);
    });

    it("deleteSchema cascades geometries too", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point");

      await t.mutation(api.lib.createEntry, {
        data: {},
        geometry: { coordinates: [1, 1], type: "Point" },
        schemaId,
      });
      // Sanity: the geometries row exists before deletion.
      expect(await t.query(api.lib.listGeometries, { schemaId })).toHaveLength(1);

      await t.mutation(api.lib.deleteSchema, { schemaId });

      // `listGeometries` 404s on the deleted schemaId (it checks schema
      // existence first), so inspect storage directly for orphans.
      const orphanedGeometries = await t.run(async (ctx) =>
        ctx.db
          .query("geometries")
          .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
          .collect(),
      );
      expect(orphanedGeometries).toHaveLength(0);
    });

    it("createEntriesBulk computes the aggregate featureCount/boundingBox in a single schemas patch", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point");

      await t.mutation(api.lib.createEntriesBulk, {
        entries: [
          { data: { n: 1 }, geometry: { coordinates: [0, 0], type: "Point" } },
          { data: { n: 2 } }, // No geometry — should not affect featureCount/boundingBox.
          { data: { n: 3 }, geometry: { coordinates: [5, 5], type: "Point" } },
        ],
        schemaId,
      });

      const schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(2);
      expect(schemaDoc.boundingBox).toStrictEqual([0, 0, 5, 5]);

      const geometries = await t.query(api.lib.listGeometries, { schemaId });
      expect(geometries).toHaveLength(2);
    });
  });

  describe("entry operations", () => {
    it("create and list entries", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        entryId = await t.mutation(api.lib.createEntry, {
          data: { age: 30, name: "John" },
          schemaId,
        });
      expect(entryId).toBeDefined();

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(1);
      expect(entries[0].data).toStrictEqual({ age: 30, name: "John" });
      expect(entries[0].schemaId).toStrictEqual(schemaId);
    });

    it("get entry", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        entryId = await t.mutation(api.lib.createEntry, {
          data: { name: "John" },
          schemaId,
        }),
        entry = await t.query(api.lib.getEntry, { entryId });
      assertDefined(entry);
      expect(entry.data).toStrictEqual({ name: "John" });
    });

    it("get entry returns null for non-existent", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        // Create and delete an entry
        entryId = await t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          schemaId,
        });
      await t.mutation(api.lib.deleteEntry, { entryId });

      // Now the ID should return null
      const entry = await t.query(api.lib.getEntry, { entryId });
      expect(entry).toBeNull();
    });

    it("create entries in bulk", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        ids = await t.mutation(api.lib.createEntriesBulk, {
          entries: [
            { data: { name: "John" } },
            { data: { name: "Jane" } },
            { data: { name: "Bob" } },
          ],
          schemaId,
        });
      expect(ids).toHaveLength(3);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(3);
    });

    it("update entry", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        entryId = await t.mutation(api.lib.createEntry, {
          data: { age: 30, name: "John" },
          schemaId,
        });

      await t.mutation(api.lib.updateEntry, {
        data: { age: 31, name: "John" },
        entryId,
      });

      const entry = await t.query(api.lib.getEntry, { entryId });
      assertDefined(entry);
      expect(entry.data).toStrictEqual({ age: 31, name: "John" });
    });

    it("delete entry", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        entryId = await t.mutation(api.lib.createEntry, {
          data: { name: "John" },
          schemaId,
        });

      await t.mutation(api.lib.deleteEntry, { entryId });

      const entry = await t.query(api.lib.getEntry, { entryId });
      expect(entry).toBeNull();
    });

    it("delete entries by schema", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t);

      await t.mutation(api.lib.createEntry, {
        data: { name: "John" },
        schemaId,
      });
      await t.mutation(api.lib.createEntry, {
        data: { name: "Jane" },
        schemaId,
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
    it("schema exceeding 100KB throws error", async () => {
      const t = initConvexTest(),
        // Create a large schema that exceeds 100KB
        largeSchema = {
          description: "A very large schema",
          properties: {} as Record<string, any>,
          title: "Large Schema",
          type: "object",
        };

      // Add enough properties to exceed 100KB
      for (let i = 0; i < 5000; i += 1) {
        largeSchema.properties[`field${i}`] = {
          description: `This is a very long description for field ${i} that will help us reach the 100KB limit faster by adding more characters to the JSON string`,
          type: "string",
        };
      }

      await expect(t.mutation(api.lib.createSchema, { schema: largeSchema })).rejects.toThrow(
        "Schema exceeds the 100 KB size limit",
      );
    });

    it("update with schema exceeding 100KB throws error", async () => {
      const t = initConvexTest(),
        testSchema = {
          description: "A test schema",
          title: "Test Schema",
          type: "object",
        },
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: testSchema,
        }),
        largeSchema = {
          description: "A very large schema",
          properties: {} as Record<string, any>,
          title: "Large Schema",
          type: "object",
        };

      for (let i = 0; i < 5000; i += 1) {
        largeSchema.properties[`field${i}`] = {
          description: `This is a very long description for field ${i} that will help us reach the 100KB limit faster by adding more characters to the JSON string`,
          type: "string",
        };
      }

      await expect(
        t.mutation(api.lib.updateSchema, {
          schema: largeSchema,
          schemaId,
        }),
      ).rejects.toThrow("Schema exceeds the 100 KB size limit");
    });
  });

  describe("integration", () => {
    it("multiple schemas with entries are isolated", async () => {
      const t = initConvexTest(),
        schemaId1 = await t.mutation(api.lib.createSchema, {
          schema: {
            description: "First schema",
            title: "Schema 1",
            type: "object",
          },
        }),
        schemaId2 = await t.mutation(api.lib.createSchema, {
          schema: {
            description: "Second schema",
            title: "Schema 2",
            type: "object",
          },
        });

      await t.mutation(api.lib.createEntry, {
        data: { source: "schema1" },
        schemaId: schemaId1,
      });

      await t.mutation(api.lib.createEntry, {
        data: { source: "schema2" },
        schemaId: schemaId2,
      });

      const entries1 = await t.query(api.lib.listEntries, {
          schemaId: schemaId1,
        }),
        entries2 = await t.query(api.lib.listEntries, {
          schemaId: schemaId2,
        });

      expect(entries1).toHaveLength(1);
      expect(entries2).toHaveLength(1);
      expect(entries1[0].data.source).toBe("schema1");
      expect(entries2[0].data.source).toBe("schema2");
    });

    it("entries are ordered by creation time descending", async () => {
      const t = initConvexTest(),
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: {
            description: "A test schema",
            title: "Test Schema",
            type: "object",
          },
        });

      // Create entries with timestamps
      await t.mutation(api.lib.createEntry, {
        data: { order: 1 },
        schemaId,
      });

      vi.advanceTimersByTime(1000);

      await t.mutation(api.lib.createEntry, {
        data: { order: 2 },
        schemaId,
      });

      vi.advanceTimersByTime(1000);

      await t.mutation(api.lib.createEntry, {
        data: { order: 3 },
        schemaId,
      });

      const entries = await t.query(api.lib.listEntries, { schemaId });

      // Should be in reverse order (newest first)
      expect(entries[0].data.order).toBe(3);
      expect(entries[1].data.order).toBe(2);
      expect(entries[2].data.order).toBe(1);
    });
  });

  describe("dataset import", () => {
    // NOTE: startImport's happy path and the full workflow *execution*
    // (importWorkflow driving batches) aren't unit-tested here. The workflow
    // Engine (a) requires registering the nested workflow component, whose
    // Shipped test source is type-incompatible with this repo's convex-test
    // Version, and (b) deletes `global.process` for determinism, which the
    // Convex-test edge-runtime doesn't provide (a step fails with "process is
    // Not defined" under the harness only). The real deployment compiles and
    // Runs it fine. We instead verify the guard plus the batch-insert
    // Primitives the workflow calls.
    it("insertEntriesChunkInternal inserts a batch of entries", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t),
        chunk = Array.from({ length: 300 }, (_, i) => ({ data: { name: `row-${i}` } }));

      await t.mutation(internal.lib.insertEntriesChunkInternal, {
        dataArray: chunk,
        schemaId,
      });

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(chunk.length);
    });

    it("insertChunkFromStorage reads storage and inserts the requested slice", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t),
        rows = Array.from({ length: 1200 }, (_, i) => ({ data: { name: `row-${i}` } })),
        storageId = await storeRows(t, rows),
        // Insert the middle batch [500, 1000).
        inserted = await t.action(internal.lib.insertChunkFromStorage, {
          limit: 500,
          offset: 500,
          schemaId,
          storageId,
        });
      expect(inserted).toBe(500);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(500);
    });

    it("startImport rejects a missing schema", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t),
        storageId = await storeRows(t, [{ name: "a" }]);

      // Delete the schema so startImport can't find it.
      await t.mutation(api.lib.deleteSchema, { schemaId });

      await expect(
        t.mutation(api.lib.startImport, { schemaId, storageId, total: 1 }),
      ).rejects.toThrow("Schema not found");
    });
  });
});

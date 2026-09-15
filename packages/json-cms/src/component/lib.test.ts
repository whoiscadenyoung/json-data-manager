import { it, afterEach, describe, expect, beforeEach, vi } from "vitest";
/// <reference types="vite/client" />

import type { GeometryArgs, GeometryTypeArg } from "../shared/geojson/validators.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { INLINE_GEOMETRY_BYTE_LIMIT } from "./geometry_storage.js";
import { initConvexTest } from "./setup.test.js";

/** Builds a synthetic closed ring with `pointCount` positions — used to exercise geometries whose coordinate array exceeds Convex's 8192-elements-per-array limit, without needing a real multi-MB fixture file. Points are spread around a small circle so they're structurally valid (finite, in-range) and distinct. */
function bigRing(pointCount: number): number[][] {
  // `|| 0` normalizes a `-0` result (e.g. right at an angle where sin/cos
  // rounds to negative zero) to plain `0` — `JSON.stringify(-0) === "0"`, so
  // without this a fixture value could "round-trip" through JSON as `0`
  // instead of `-0` and fail a strict-equality assertion for a reason that
  // has nothing to do with the code under test.
  const round = (n: number) => Number(n.toFixed(6)) || 0,
    ring: number[][] = [];
  for (let i = 0; i < pointCount - 1; i += 1) {
    const angle = (2 * Math.PI * i) / (pointCount - 1);
    ring.push([round(Math.cos(angle) * 0.01), round(Math.sin(angle) * 0.01)]);
  }
  ring.push(ring[0]); // Close the ring (first === last).
  return ring;
}

type TestCtx = ReturnType<typeof initConvexTest>;

function assertDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be defined");
  }
}

/**
 * `listGeometries` is paginated (see its doc comment in lib.ts — a dataset's
 * cumulative geometry payload can exceed Convex's per-execution read-byte
 * budget even though each row is safely under its own document-size limit).
 * Fetches every page and returns the merged, flat array — what most tests
 * actually want to assert against.
 */
async function listAllGeometries(t: TestCtx, schemaId: Id<"schemas">) {
  const fetchPage = async (cursor: string | null) =>
      t.query(api.lib.listGeometries, { paginationOpts: { cursor, numItems: 1000 }, schemaId }),
    pages: Array<Awaited<ReturnType<typeof fetchPage>>["page"][number]> = [];
  let cursor: string | null = null,
    isDone = false;
  while (!isDone) {
    // oxlint-disable-next-line no-await-in-loop -- each page's cursor depends on the previous one; inherently sequential.
    const result = await fetchPage(cursor);
    pages.push(...result.page);
    isDone = result.isDone;
    cursor = result.continueCursor;
  }
  return pages;
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
          geometry: JSON.stringify(validPolygon),
          schemaId,
        }),
      ).rejects.toThrow("Cannot attach geometry to a standard dataset.");
    });

    it("createEntry on a MultiPolygon-locked schema accepts a Polygon geometry (asymmetric compatibility)", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "MultiPolygon"),
        entryId = await t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          geometry: JSON.stringify(validPolygon),
          schemaId,
        }),
        entry = await t.query(api.lib.getEntry, { entryId });
      assertDefined(entry);
      // Stored as a pointer, not inline: `entries` never carries coordinates.
      expect(entry).not.toHaveProperty("geometry");
      expect(entry.geometryType).toBe("Polygon");
      assertDefined(entry.geometryId);

      // The real coordinates live only in `geometries`.
      const geometries = await listAllGeometries(t, schemaId),
        geometryDoc = geometries.find((g) => g._id === entry.geometryId);
      assertDefined(geometryDoc);
      assertDefined(geometryDoc.geometryJson);
      expect(JSON.parse(geometryDoc.geometryJson)).toStrictEqual(validPolygon);
      expect(geometryDoc.type).toBe("Polygon");
      expect(geometryDoc.entryId).toBe(entryId);
    });

    it("createEntry on a Polygon-locked schema rejects a MultiPolygon geometry (other direction of the asymmetry)", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon");

      await expect(
        t.mutation(api.lib.createEntry, {
          data: { name: "test" },
          geometry: JSON.stringify(validMultiPolygon),
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
          geometry: JSON.stringify(invalidPoint),
          schemaId,
        }),
      ).rejects.toThrow("longitude must be a finite number in [-180, 180]");
    });

    it("createEntry rejects a geometry too large to store inline, with an actionable error", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        // A ring big enough that its JSON text exceeds INLINE_GEOMETRY_BYTE_LIMIT.
        huge = JSON.stringify({ coordinates: [bigRing(60_000)], type: "Polygon" });
      expect(huge.length).toBeGreaterThan(INLINE_GEOMETRY_BYTE_LIMIT);

      await expect(
        t.mutation(api.lib.createEntry, { data: {}, geometry: huge, schemaId }),
      ).rejects.toThrow("too large to attach directly");
    });

    it("featureCount/boundingBox track create -> update (replace) -> delete", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        pointA: GeometryArgs = { coordinates: [0, 0], type: "Point" },
        pointB: GeometryArgs = { coordinates: [10, 10], type: "Point" },
        pointC: GeometryArgs = { coordinates: [-5, -5], type: "Point" },
        entryId = await t.mutation(api.lib.createEntry, {
          data: {},
          geometry: JSON.stringify(pointA),
          schemaId,
        });

      let schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(1);
      expect(schemaDoc.boundingBox).toStrictEqual([0, 0, 0, 0]);

      // Replace the geometry with one further out: bbox grows, count is unchanged
      // (a replace, not an add), and the SAME `geometries` row is reused in place.
      await t.mutation(api.lib.updateEntry, {
        data: {},
        entryId,
        geometry: JSON.stringify(pointB),
      });

      schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(1);
      expect(schemaDoc.boundingBox).toStrictEqual([0, 0, 10, 10]);

      const geometriesAfterUpdate = await listAllGeometries(t, schemaId);
      expect(geometriesAfterUpdate).toHaveLength(1);
      assertDefined(geometriesAfterUpdate[0].geometryJson);
      expect(JSON.parse(geometriesAfterUpdate[0].geometryJson)).toStrictEqual(pointB);

      // A second entry elsewhere, to prove the bbox stays monotonic through a later delete.
      await t.mutation(api.lib.createEntry, {
        data: {},
        geometry: JSON.stringify(pointC),
        schemaId,
      });

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

      const geometriesAfterDelete = await listAllGeometries(t, schemaId);
      expect(geometriesAfterDelete).toHaveLength(1);
    });

    it("updateEntry with geometry: null explicitly clears geometry and decrements featureCount", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        entryId = await t.mutation(api.lib.createEntry, {
          data: {},
          geometry: JSON.stringify({ coordinates: [1, 1], type: "Point" }),
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

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(0);
    });

    it("deleteSchema cascades geometries too", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point");

      await t.mutation(api.lib.createEntry, {
        data: {},
        geometry: JSON.stringify({ coordinates: [1, 1], type: "Point" }),
        schemaId,
      });
      // Sanity: the geometries row exists before deletion.
      expect(await listAllGeometries(t, schemaId)).toHaveLength(1);

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
          { data: { n: 1 }, geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }) },
          { data: { n: 2 } }, // No geometry — should not affect featureCount/boundingBox.
          { data: { n: 3 }, geometry: JSON.stringify({ coordinates: [5, 5], type: "Point" }) },
        ],
        schemaId,
      });

      const schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.featureCount).toBe(2);
      expect(schemaDoc.boundingBox).toStrictEqual([0, 0, 5, 5]);

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(2);
    });

    it("a geometry with a coordinate ring larger than 8192 elements round-trips exactly via createEntry", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        // Comfortably over Convex's 8192-elements-per-array limit, and small
        // enough as JSON text to land inline (see INLINE_GEOMETRY_BYTE_LIMIT).
        ring = bigRing(10_000),
        geometry: GeometryArgs = { coordinates: [ring], type: "Polygon" },
        entryId = await t.mutation(api.lib.createEntry, {
          data: {},
          geometry: JSON.stringify(geometry),
          schemaId,
        });

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(1);
      assertDefined(geometries[0].geometryJson);
      const roundTripped = JSON.parse(geometries[0].geometryJson);
      expect(roundTripped).toStrictEqual(geometry);
      expect(roundTripped.coordinates[0]).toHaveLength(ring.length);
      expect(geometries[0].entryId).toBe(entryId);
    });

    describe("listGeometries pagination", () => {
      // Regression coverage for: individual rows safely under
      // INLINE_GEOMETRY_BYTE_LIMIT (~900 KB) can still, in aggregate, exceed
      // Convex's ~16 MiB per-execution read budget when a dataset has many
      // of them — this is what actually threw "Too many bytes read in a
      // single function execution" against the real 521-row/80 MB file
      // before `listGeometries` was paginated.
      it("many near-inline-limit geometries for one schema page correctly and nothing is lost across pages", async () => {
        // `convex-test`'s in-memory `.paginate()` simulation doesn't enforce
        // `maximumBytesRead` the way a deployed backend does (verified: this
        // exact fixture, requested as one `numItems: ROW_COUNT` page, comes
        // back whole here instead of split) — so this test proves the
        // pagination *mechanism* (cursors, page boundaries, no data lost)
        // rather than the production safety net itself. The safety net —
        // `maximumBytesRead: GEOMETRY_READ_BYTE_BUDGET` passed to every
        // `.paginate()` call in `listGeometries`/lib.ts — was confirmed
        // separately against a real deployment (see the PR notes): the exact
        // failure this fixture models ("Too many bytes read in a single
        // function execution") reproduced against unpaginated `.collect()`
        // and is gone after this change.
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Polygon"),
          ROW_COUNT = 12,
          // ~850 KB per geometry as JSON text — comfortably inline
          // (< INLINE_GEOMETRY_BYTE_LIMIT) but realistically close to it,
          // matching the largest inline rows in the real 80 MB fixture file.
          ring = bigRing(34_000),
          geometryJson = JSON.stringify({ coordinates: [ring], type: "Polygon" });
        expect(new TextEncoder().encode(geometryJson).length).toBeLessThan(
          INLINE_GEOMETRY_BYTE_LIMIT,
        );

        for (let i = 0; i < ROW_COUNT; i += 1) {
          // oxlint-disable-next-line no-await-in-loop -- seeding fixture rows; order doesn't matter but each is cheap and sequential is simplest here.
          await t.mutation(api.lib.createEntry, {
            data: { n: i },
            geometry: geometryJson,
            schemaId,
          });
        }

        // A deliberately small requested page size proves the pagination
        // mechanism itself works: multiple calls are required, and none of
        // them silently reads (or returns) more than asked.
        const firstPage = await t.query(api.lib.listGeometries, {
          paginationOpts: { cursor: null, numItems: 5 },
          schemaId,
        });
        expect(firstPage.page).toHaveLength(5);
        expect(firstPage.isDone).toBe(false);

        // Nothing is dropped — every row is still reachable, just fetched
        // across more, smaller reads instead of one big one.
        const all = await listAllGeometries(t, schemaId);
        expect(all).toHaveLength(ROW_COUNT);
        for (const row of all) {
          assertDefined(row.geometryJson);
          expect(JSON.parse(row.geometryJson).coordinates[0]).toHaveLength(ring.length);
        }
      });

      // NOTE: there is no server-side `listGeometriesByCollection` to test
      // here — Convex allows at most one `.paginate()` call per query
      // execution ("Only a single paginated query is allowed per function
      // execution", a hard platform limit an earlier version of this fix
      // violated by looping `.paginate()` across a collection's schemas in
      // one query — it failed exactly this way against this exact test
      // harness, which is how it was caught before it reached production).
      // Aggregating a collection's geometries across its several
      // independently-indexed schemas is the client's job instead: call
      // this same paginated `listGeometries` once per geospatial schema and
      // merge — see `SchemaGeometriesLoader` in the app's collection route.
      it("listGeometries stays correctly scoped per schema — paginating one schema never returns another schema's rows", async () => {
        const t = initConvexTest(),
          schemaA = await createGeospatialSchema(t, "Point"),
          schemaB = await createGeospatialSchema(t, "Point");

        for (let i = 0; i < 3; i += 1) {
          // oxlint-disable-next-line no-await-in-loop
          await t.mutation(api.lib.createEntry, {
            data: { i },
            geometry: JSON.stringify({ coordinates: [i, i], type: "Point" }),
            schemaId: schemaA,
          });
        }
        for (let i = 0; i < 4; i += 1) {
          // oxlint-disable-next-line no-await-in-loop
          await t.mutation(api.lib.createEntry, {
            data: { i },
            geometry: JSON.stringify({ coordinates: [-i, -i], type: "Point" }),
            schemaId: schemaB,
          });
        }

        const geometriesA = await listAllGeometries(t, schemaA),
          geometriesB = await listAllGeometries(t, schemaB);
        expect(geometriesA).toHaveLength(3);
        expect(geometriesB).toHaveLength(4);
        expect(geometriesA.every((row) => row.schemaId === schemaA)).toBe(true);
        expect(geometriesB.every((row) => row.schemaId === schemaB)).toBe(true);
      });
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
    // (importWorkflow driving chunks) aren't unit-tested here. The workflow
    // Engine (a) requires registering the nested workflow component, whose
    // Shipped test source is type-incompatible with this repo's convex-test
    // Version, and (b) deletes `global.process` for determinism, which the
    // Convex-test edge-runtime doesn't provide (a step fails with "process is
    // Not defined" under the harness only). The real deployment compiles and
    // Runs it fine. We instead verify the guard plus the batch-insert
    // Primitives the workflow calls, directly — including `insertChunkFromStorage`,
    // which now does the per-row geometry validation/resolution itself (see
    // its doc comment: Convex components can't use the Node runtime, so that
    // work can't happen in a separate whole-payload prep step anymore —
    // chunking instead happens client-side, via `chunkRowsForImport` in the
    // `react` package, before any of these component functions run at all).
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

    it("insertChunkFromStorage reads a raw client-uploaded chunk blob, validates + inserts it, then deletes the blob", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t),
        chunkRows = Array.from({ length: 500 }, (_, i) => ({ data: { name: `row-${i}` } })),
        storageId = await storeRows(t, chunkRows),
        inserted = await t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId });
      expect(inserted).toBe(500);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(500);

      // The chunk blob is deleted once its rows are inserted (import-litter cleanup).
      const stillThere = await t.run(async (ctx) => ctx.storage.get(storageId));
      expect(stillThere).toBeNull();
    });

    it("startImport rejects a missing schema", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t),
        storageId = await storeRows(t, [{ name: "a" }]);

      // Delete the schema so startImport can't find it.
      await t.mutation(api.lib.deleteSchema, { schemaId });

      await expect(
        t.mutation(api.lib.startImport, { schemaId, storageIds: [storageId], total: 1 }),
      ).rejects.toThrow("Schema not found");
    });

    it("a geometry with a coordinate ring larger than 8192 elements round-trips exactly through insertChunkFromStorage", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        ring = bigRing(9000), // > 8192, but small enough as JSON text to land inline.
        geometry = { coordinates: [ring], type: "Polygon" },
        storageId = await storeRows(t, [{ data: { name: "big" }, geometry }]);

      await t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId });

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(1);
      assertDefined(geometries[0].geometryJson);
      const roundTripped = JSON.parse(geometries[0].geometryJson);
      expect(roundTripped).toStrictEqual(geometry);
      expect(roundTripped.coordinates[0]).toHaveLength(ring.length);
    });

    it("falls back to file storage for a geometry too large to store inline, and the blob resolves to the exact original geometry", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        ring = bigRing(70_000), // JSON text comfortably exceeds INLINE_GEOMETRY_BYTE_LIMIT.
        geometry = { coordinates: [ring], type: "Polygon" },
        geometryJsonSize = JSON.stringify(geometry).length;
      expect(geometryJsonSize).toBeGreaterThan(INLINE_GEOMETRY_BYTE_LIMIT);

      const storageId = await storeRows(t, [{ data: { name: "huge" }, geometry }]);
      await t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId });

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(1);
      expect(geometries[0].geometryJson).toBeUndefined();
      assertDefined(geometries[0].geometryUrl);

      // convex-test doesn't serve real HTTP for storage URLs, so verify the
      // underlying blob directly instead of following the URL — a real
      // deployment's URL fetches this same blob byte-for-byte.
      const geometryRow = await t.run(async (ctx) =>
        ctx.db
          .query("geometries")
          .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
          .first(),
      );
      assertDefined(geometryRow);
      assertDefined(geometryRow.geometryStorageId);
      const geometryStorageId = geometryRow.geometryStorageId,
        // Read + parse inside the `t.run` callback — its return value goes
        // through Convex's value serialization, which (correctly) can't
        // carry a raw `Blob` back out.
        storedJson: unknown = await t.run(async (ctx) => {
          const blob = await ctx.storage.get(geometryStorageId);
          assertDefined(blob);
          return JSON.parse(await blob.text());
        });
      expect(storedJson).toStrictEqual(geometry);
      expect((storedJson as typeof geometry).coordinates[0]).toHaveLength(ring.length);
    });

    it("processes many client-produced chunks (simulating a large import) without ever holding more than one chunk at a time", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t),
        rows = Array.from({ length: 1200 }, (_, i) => ({ data: { name: `row-${i}` } })),
        // Mirrors what the client does before calling startImport — see
        // chunk-rows.test.ts for dedicated coverage of the splitting logic itself.
        chunks = [rows.slice(0, 500), rows.slice(500, 1000), rows.slice(1000, 1200)];
      expect(chunks.map((c) => c.length)).toStrictEqual([500, 500, 200]);

      let totalInserted = 0;
      for (const chunk of chunks) {
        const storageId = await storeRows(t, chunk);
        // oxlint-disable-next-line no-await-in-loop
        totalInserted += await t.action(internal.lib.insertChunkFromStorage, {
          schemaId,
          storageId,
        });
      }
      expect(totalInserted).toBe(1200);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(1200);
    });

    it("rejects a chunk atomically when one of its rows has an invalid geometry, before writing any of that chunk's rows", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        storageId = await storeRows(t, [
          { data: { n: 1 }, geometry: { coordinates: [0, 0], type: "Point" } },
          { data: { n: 2 }, geometry: { coordinates: [200, 0], type: "Point" } }, // out-of-range longitude
        ]);

      await expect(
        t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId }),
      ).rejects.toThrow(/Row 1/);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(0);
    });

    it("a later chunk's failure does not undo an earlier chunk's already-committed rows (documented trade-off — see importWorkflow's doc comment)", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        goodStorageId = await storeRows(t, [
          { data: { n: 1 }, geometry: { coordinates: [0, 0], type: "Point" } },
        ]),
        badStorageId = await storeRows(t, [
          { data: { n: 2 }, geometry: { coordinates: [200, 0], type: "Point" } }, // out-of-range longitude
        ]);

      await t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId: goodStorageId });
      await expect(
        t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId: badStorageId }),
      ).rejects.toThrow(/Row 0/);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(1);
    });
  });

  describe("geospatial conversion", () => {
    // startGeospatialConversion's happy path kicks off the workflow Engine,
    // which isn't unit-testable here (see the dataset import note above), so
    // these assert the guard and the batch primitive the workflow drives —
    // exactly, page by page, as geospatialConversionWorkflow would.
    async function createCoordinateSchema(t: TestCtx) {
      return t.mutation(api.lib.createSchema, {
        schema: {
          description: "Tabular rows with coordinate columns",
          properties: {
            Latitude: { type: "number" },
            Longitude: { type: "number" },
            Name: { type: "string" },
          },
          title: "Coordinate Schema",
          type: "object",
        },
      });
    }

    async function runConversion(t: TestCtx, schemaId: Id<"schemas">) {
      let cursor: string | null = null,
        geocoded = 0,
        isDone = false;
      while (!isDone) {
        // oxlint-disable-next-line no-await-in-loop -- each page's cursor depends on the previous one.
        const result = await t.mutation(internal.lib.convertEntriesBatchInternal, {
          cursor,
          latField: "Latitude",
          lonField: "Longitude",
          schemaId,
        });
        cursor = result.continueCursor;
        geocoded += result.geocoded;
        isDone = result.isDone;
      }
      return geocoded;
    }

    it("startGeospatialConversion rejects converting an already-geospatial dataset", async () => {
      const t = initConvexTest(),
        schemaId = await t.mutation(api.lib.createSchema, {
          geometryType: "Point",
          kind: "geospatial",
          schema: {
            description: "Already geospatial",
            properties: {
              Latitude: { type: "number" },
              Longitude: { type: "number" },
            },
            title: "Geospatial",
            type: "object",
          },
        });

      await expect(
        t.mutation(api.lib.startGeospatialConversion, {
          latField: "Latitude",
          lonField: "Longitude",
          schemaId,
          total: 0,
        }),
      ).rejects.toThrow("already geospatial");
    });

    it("conversion preserves every entry property — including the Latitude/Longitude columns it consumes — while backfilling Point geometry (regression: #31)", async () => {
      const t = initConvexTest(),
        schemaId = await createCoordinateSchema(t),
        rows = [
          { Latitude: 44.33354, Longitude: -108.03041, Name: "valid" },
          { Latitude: 0, Longitude: 0, Name: "origin" },
          { Latitude: 999, Longitude: 0, Name: "invalid-lat" }, // out of range — skipped, not modified
          { Name: "no-coords" },
        ],
        createdIds = [];
      for (const data of rows) {
        // oxlint-disable-next-line no-await-in-loop -- sequential inserts keep createdIds aligned with rows.
        createdIds.push(await t.mutation(api.lib.createEntry, { data, schemaId }));
      }

      const geocoded = await runConversion(t, schemaId);
      expect(geocoded).toBe(2);

      const entries = await t.query(api.lib.listEntries, { schemaId });
      expect(entries).toHaveLength(rows.length);
      for (const [i, id] of createdIds.entries()) {
        const entry = entries.find((e) => e._id === id);
        assertDefined(entry);
        // THE regression assertion: `data` — every property, coordinate
        // columns included — comes through conversion byte-for-byte.
        expect(entry.data).toStrictEqual(rows[i]);
        // Geometry lands exactly on the rows with valid coordinates.
        const hasGeometry = entry.geometryId !== undefined;
        expect(hasGeometry).toBe(i < 2);
        if (hasGeometry) {
          expect(entry.geometryType).toBe("Point");
        }
      }

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(2);
      expect(geometries.every((g) => g.type === "Point")).toBe(true);
    });
  });
});

import { it, afterEach, describe, expect, beforeEach, vi } from "vitest";
/// <reference types="vite/client" />

import type { GeometryArgs, GeometryTypeArg } from "../shared/geojson/validators.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { INLINE_GEOMETRY_BYTE_LIMIT } from "./geometry_storage.js";
import { GEOMETRY_PAGE_BYTE_BUDGET, MAP_TILE_ARCHIVE_MIN_BYTES } from "./lib.js";
import { initConvexTest } from "./setup.test.js";

/** `|| 0` normalizes a `-0` result (e.g. right at an angle where sin/cos rounds to negative zero) to plain `0` — `JSON.stringify(-0) === "0"`, so without this a fixture value could "round-trip" through JSON as `0` instead of `-0` and fail a strict-equality assertion for a reason that has nothing to do with the code under test. */
const round = (n: number) => Number(n.toFixed(6)) || 0;

/** Builds a synthetic closed ring with `pointCount` positions — used to exercise geometries whose coordinate array exceeds Convex's 8192-elements-per-array limit, without needing a real multi-MB fixture file. Points are spread around a small circle so they're structurally valid (finite, in-range) and distinct. */
function bigRing(pointCount: number): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i < pointCount - 1; i += 1) {
    const angle = (2 * Math.PI * i) / (pointCount - 1);
    ring.push([round(Math.cos(angle) * 0.01), round(Math.sin(angle) * 0.01)]);
  }
  ring.push(ring[0]); // Close the ring (first === last).
  return ring;
}

/** Seeds a collection row for collections-and-groups tests. */
async function createTestCollection(t: TestCtx, name: string) {
  return t.mutation(api.lib.createCollection, { name });
}

/** Schema for the geospatial-conversion tests: plain tabular rows with Latitude/Longitude columns. */
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

/** `convertEntriesBatchInternal`'s result, declared explicitly to break the circular reference through `internal.lib`'s own type. */
type ConversionBatchResult = { continueCursor: string; geocoded: number; isDone: boolean };

/** Drives `convertEntriesBatchInternal` to completion page by page, exactly as geospatialConversionWorkflow would. Returns the total geocoded count. */
async function runConversion(t: TestCtx, schemaId: Id<"schemas">) {
  let cursor: string | null = null,
    geocoded = 0,
    isDone = false;
  while (!isDone) {
    // oxlint-disable-next-line no-await-in-loop -- each page's cursor depends on the previous one.
    const result: ConversionBatchResult = await t.mutation(
      internal.lib.convertEntriesBatchInternal,
      {
        cursor,
        latField: "Latitude",
        lonField: "Longitude",
        schemaId,
      },
    );
    cursor = result.continueCursor;
    geocoded += result.geocoded;
    isDone = result.isDone;
  }
  return geocoded;
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

/** An entries page's row names in page order — pagination assertions read these. */
function pageNames(page: { page: Array<{ data: unknown }> }): string[] {
  return page.page.map(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every fixture row is created with a `name` property.
    (entry) => (entry.data as { name: string }).name,
  );
}

async function storeRows(t: TestCtx, rows: unknown[]) {
  return t.run(async (ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(rows)], { type: "application/json" })),
  );
}

/** Stores an archive-sized blob and installs it via `setMapTileArchive` at `expectedVersion`. */
async function installArchive(
  t: TestCtx,
  schemaId: Id<"schemas">,
  expectedVersion: number,
  label: string,
) {
  const storageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([label], { type: "application/octet-stream" })),
  );
  await t.mutation(api.lib.setMapTileArchive, {
    bytes: label.length,
    expectedVersion,
    maxZoom: 12,
    schemaId,
    storageId,
  });
  return storageId;
}

async function createGeospatialSchema(
  t: TestCtx,
  geometryType: GeometryTypeArg,
  options?: { simplifyGeometry?: boolean },
) {
  return t.mutation(api.lib.createSchema, {
    geometryType,
    kind: "geospatial",
    schema: {
      description: "A geospatial test schema",
      title: "Geospatial Schema",
      type: "object",
    },
    simplifyGeometry: options === undefined ? undefined : options.simplifyGeometry,
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
        "Schema must have a non-empty 'title' property",
      );
    });

    it("create schema without description succeeds — description is optional", async () => {
      const t = initConvexTest(),
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: { title: "Test Schema", type: "object" },
        });

      const schema = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schema);
      expect(schema.title).toBe("Test Schema");
      expect(schema.description).toBeUndefined();
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

  describe("listSchemaSummaries (issue #53)", () => {
    it("projects list-page fields without the schema/uiSchema payloads", async () => {
      const t = initConvexTest(),
        schemaId = await t.mutation(api.lib.createSchema, {
          kind: "geospatial",
          geometryType: "Point",
          schema: {
            description: "Summary projection fixture",
            properties: {
              age: { type: "number" },
              name: { type: "string" },
            },
            title: "Summary Schema",
            type: "object",
          },
          uiSchema: { name: { "ui:widget": "text" } },
        }),
        summaries = await t.query(api.lib.listSchemaSummaries, {}),
        row = summaries.find((summary) => summary._id === schemaId);
      assertDefined(row);
      expect(row.title).toBe("Summary Schema");
      expect(row.description).toBe("Summary projection fixture");
      expect(row.kind).toBe("geospatial");
      expect(row.geometryType).toBe("Point");
      expect(row.fieldCount).toBe(2);
      // The heavy fields the projection exists to drop are genuinely absent…
      expect("schema" in row).toBe(false);
      expect("uiSchema" in row).toBe(false);
      // …and the full-doc query still carries them for the editor surfaces.
      const full = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(full);
      expect(full.schema).toBeDefined();
      expect(full.uiSchema).toBeDefined();
    });

    it("counts zero fields for a schema without properties", async () => {
      const t = initConvexTest(),
        schemaId = await t.mutation(api.lib.createSchema, {
          schema: { title: "No Properties", type: "string" },
        }),
        summaries = await t.query(api.lib.listSchemaSummaries, {}),
        row = summaries.find((summary) => summary._id === schemaId);
      assertDefined(row);
      expect(row.fieldCount).toBe(0);
    });
  });

  describe("listMapLayerOverridesForMap (issue #53)", () => {
    it("returns one map's override rows, not every map's", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        mapA = await t.mutation(api.lib.createMap, { name: "Map A" }),
        mapB = await t.mutation(api.lib.createMap, { name: "Map B" });
      // `addMapLayer` returns null when the layer already exists — fresh maps
      // here, so each add must produce a layer.
      const layerA = await t.mutation(api.lib.addMapLayer, {
          mapId: mapA,
          targetId: schemaId,
          targetType: "dataset",
        }),
        layerB = await t.mutation(api.lib.addMapLayer, {
          mapId: mapB,
          targetId: schemaId,
          targetType: "dataset",
        });
      assertDefined(layerA);
      assertDefined(layerB);
      await t.mutation(api.lib.setMapLayerOverride, {
        childKey: `dataset:${schemaId}`,
        layerId: layerA,
        visible: false,
      });
      await t.mutation(api.lib.setMapLayerOverride, {
        childKey: `dataset:${schemaId}`,
        layerId: layerB,
        visible: false,
      });

      const overridesA = await t.query(api.lib.listMapLayerOverridesForMap, { mapId: mapA });
      expect(overridesA).toHaveLength(1);
      expect(overridesA[0].layerId).toBe(layerA);

      // A map with no overrides lists nothing — even though overrides exist elsewhere.
      const mapC = await t.mutation(api.lib.createMap, { name: "Map C" });
      expect(await t.query(api.lib.listMapLayerOverridesForMap, { mapId: mapC })).toHaveLength(0);
    });
  });

  describe("schema lineage (bound-dataset tag versions)", () => {
    const versionedSchema = {
        properties: { name: { type: "string" } },
        title: "Versioned Schema",
        type: "object",
      },
      createLive = async (t: TestCtx) =>
        t.mutation(api.lib.createSchema, { schema: versionedSchema }),
      freezeVersion = async (t: TestCtx, sourceSchemaId: Id<"schemas">, versionLabel: string) =>
        t.mutation(api.lib.createSchema, {
          lineage: {
            frozenAt: Date.now(),
            snapshotRef: `snap_${versionLabel}`,
            sourceSchemaId,
            versionLabel,
          },
          schema: { ...versionedSchema, title: `${versionedSchema.title} — ${versionLabel}` },
          source: { name: "restaurantLocations" },
        });

    it("createSchema stores lineage and source on the frozen version", async () => {
      const t = initConvexTest(),
        liveId = await createLive(t),
        frozenAt = Date.now(),
        versionId = await t.mutation(api.lib.createSchema, {
          lineage: {
            frozenAt,
            snapshotRef: "snap_v1",
            sourceSchemaId: liveId,
            versionLabel: "v1",
          },
          schema: versionedSchema,
          source: { name: "restaurantLocations" },
        }),
        version = await t.query(api.lib.getSchema, { schemaId: versionId });
      assertDefined(version);
      expect(version.lineage).toEqual({
        frozenAt,
        snapshotRef: "snap_v1",
        sourceSchemaId: liveId,
        versionLabel: "v1",
      });
      expect(version.source).toEqual({ name: "restaurantLocations" });
      // The live dataset itself carries no lineage.
      const live = await t.query(api.lib.getSchema, { schemaId: liveId });
      assertDefined(live);
      expect(live.lineage).toBeUndefined();
    });

    it("listSchemaVersions returns only that source's versions, newest first", async () => {
      const t = initConvexTest(),
        liveId = await createLive(t),
        otherLiveId = await createLive(t);
      await freezeVersion(t, liveId, "v1");
      // A tick so the second freeze sorts after the first.
      vi.advanceTimersByTime(1);
      await freezeVersion(t, liveId, "v2");
      // A different live dataset's version — proves the listing is scoped.
      await freezeVersion(t, otherLiveId, "other-v1");

      const versions = await t.query(api.lib.listSchemaVersions, { sourceSchemaId: liveId });
      expect(versions).toHaveLength(2);
      expect(versions.map((version) => version.title)).toEqual([
        "Versioned Schema — v2",
        "Versioned Schema — v1",
      ]);

      const otherVersions = await t.query(api.lib.listSchemaVersions, {
        sourceSchemaId: otherLiveId,
      });
      expect(otherVersions).toHaveLength(1);

      // Ordinary datasets (no versions) list nothing.
      const plainId = await t.mutation(api.lib.createSchema, { schema: versionedSchema });
      const none = await t.query(api.lib.listSchemaVersions, { sourceSchemaId: plainId });
      expect(none).toHaveLength(0);
    });

    it("getSchemaVersionBySnapshotRef resolves the frozen version by ref", async () => {
      const t = initConvexTest(),
        liveId = await createLive(t),
        versionId = await freezeVersion(t, liveId, "v1"),
        found = await t.query(api.lib.getSchemaVersionBySnapshotRef, { snapshotRef: "snap_v1" });
      assertDefined(found);
      expect(found._id).toBe(versionId);

      const unknown = await t.query(api.lib.getSchemaVersionBySnapshotRef, {
        snapshotRef: "snap_missing",
      });
      expect(unknown).toBeNull();
    });
  });

  describe("collections & groups", () => {
    it("creates standalone groups without a collection", async () => {
      const t = initConvexTest(),
        groupId = await t.mutation(api.lib.createGroup, { name: "Standalone group" }),
        group = await t.query(api.lib.getGroup, { groupId });
      assertDefined(group);
      expect(group.name).toBe("Standalone group");
      expect(group.collectionId).toBeUndefined();
    });

    it("creates nested groups with a validated collection", async () => {
      const t = initConvexTest(),
        collectionId = await createTestCollection(t, "Grant data"),
        groupId = await t.mutation(api.lib.createGroup, {
          collectionId,
          name: "SMART Grant 2025",
        }),
        group = await t.query(api.lib.getGroup, { groupId });
      assertDefined(group);
      expect(group.collectionId).toBe(collectionId);

      await expect(t.mutation(api.lib.createGroup, { collectionId, name: " " })).rejects.toThrow(
        "Group must have a name",
      );
    });

    it("lists all groups when no collection filter is given", async () => {
      const t = initConvexTest(),
        collectionId = await createTestCollection(t, "Grant data"),
        nestedId = await t.mutation(api.lib.createGroup, { collectionId, name: "Nested" }),
        standaloneId = await t.mutation(api.lib.createGroup, { name: "Standalone" });

      const all = await t.query(api.lib.listGroups, {});
      expect(all.map((group) => group._id).toSorted()).toEqual([nestedId, standaloneId].toSorted());

      const nested = await t.query(api.lib.listGroups, { collectionId });
      expect(nested.map((group) => group._id)).toEqual([nestedId]);
    });

    it("adds a dataset to multiple collections without duplication", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        firstId = await createTestCollection(t, "First"),
        secondId = await createTestCollection(t, "Second");

      await t.mutation(api.lib.addSchemaToCollection, { collectionId: firstId, schemaId });
      await t.mutation(api.lib.addSchemaToCollection, { collectionId: secondId, schemaId });
      // Adding the same membership twice is a no-op.
      await t.mutation(api.lib.addSchemaToCollection, { collectionId: firstId, schemaId });

      const collections = await t.query(api.lib.listCollectionsBySchema, { schemaId });
      expect(collections.map((collection) => collection._id).toSorted()).toEqual(
        [firstId, secondId].toSorted(),
      );
      expect(await t.query(api.lib.listSchemaCollections, {})).toHaveLength(2);

      const firstDatasets = await t.query(api.lib.listSchemasByCollection, {
        collectionId: firstId,
      });
      expect(firstDatasets.map((dataset) => dataset._id)).toEqual([schemaId]);
    });

    it("removes one collection membership and keeps the rest", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        firstId = await createTestCollection(t, "First"),
        secondId = await createTestCollection(t, "Second");

      await t.mutation(api.lib.addSchemaToCollection, { collectionId: firstId, schemaId });
      await t.mutation(api.lib.addSchemaToCollection, { collectionId: secondId, schemaId });
      await t.mutation(api.lib.removeSchemaFromCollection, { collectionId: firstId, schemaId });

      const collections = await t.query(api.lib.listCollectionsBySchema, { schemaId });
      expect(collections.map((collection) => collection._id)).toEqual([secondId]);
    });

    it("keeps group membership and collection membership independent", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        collectionId = await createTestCollection(t, "Grant data"),
        groupId = await t.mutation(api.lib.createGroup, { collectionId, name: "Nested" });

      // Setting a group must not join the group's collection…
      await t.mutation(api.lib.setSchemaGroup, { groupId, schemaId });
      expect(await t.query(api.lib.listCollectionsBySchema, { schemaId })).toEqual([]);

      // …and joining a collection must not touch the group.
      await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
      const dataset = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(dataset);
      expect(dataset.groupId).toBe(groupId);

      // Clearing the group leaves the collection membership alone.
      await t.mutation(api.lib.setSchemaGroup, { groupId: null, schemaId });
      const afterClear = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(afterClear);
      expect(afterClear.groupId).toBeUndefined();
      expect(
        (await t.query(api.lib.listCollectionsBySchema, { schemaId })).map((c) => c._id),
      ).toEqual([collectionId]);
    });

    it("deleting a collection removes only its own memberships and nested groups", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        otherSchemaId = await createTestSchema(t),
        doomedId = await createTestCollection(t, "Doomed"),
        survivorId = await createTestCollection(t, "Survivor"),
        doomedGroupId = await t.mutation(api.lib.createGroup, {
          collectionId: doomedId,
          name: "Doomed group",
        });

      await t.mutation(api.lib.addSchemaToCollection, { collectionId: doomedId, schemaId });
      await t.mutation(api.lib.addSchemaToCollection, { collectionId: survivorId, schemaId });
      await t.mutation(api.lib.setSchemaGroup, { groupId: doomedGroupId, schemaId: otherSchemaId });

      await t.mutation(api.lib.deleteCollection, { collectionId: doomedId });

      // Membership in the survivor survives; the doomed collection is gone.
      const collections = await t.query(api.lib.listCollectionsBySchema, { schemaId });
      expect(collections.map((collection) => collection._id)).toEqual([survivorId]);
      expect(await t.query(api.lib.getCollection, { collectionId: doomedId })).toBeNull();

      // The nested group died, and its datasets became ungrouped — but kept
      // their own collection memberships.
      expect(await t.query(api.lib.getGroup, { groupId: doomedGroupId })).toBeNull();
      const ungrouped = await t.query(api.lib.getSchema, { schemaId: otherSchemaId });
      assertDefined(ungrouped);
      expect(ungrouped.groupId).toBeUndefined();
    });

    it("cleans up collection memberships when a dataset is deleted", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        collectionId = await createTestCollection(t, "Grant data");

      await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
      await t.mutation(api.lib.deleteSchema, { schemaId });

      expect(await t.query(api.lib.listSchemaCollections, {})).toEqual([]);
      expect(await t.query(api.lib.listSchemasByCollection, { collectionId })).toEqual([]);
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

      // The page budget is measured in BYTES, not rows: a page of tiny
      // geometries fills toward the row ceiling instead of stopping at a
      // fixed count. This is the shape of the audit's SMART dataset — 13 KB
      // of points that cost 17 round trips under the old fixed 8-row cap —
      // which must now fit one page.
      it("small geometries fill a whole page well past the old fixed row cap", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Point"),
          ROW_COUNT = 100;
        await t.mutation(api.lib.createEntriesBulk, {
          entries: Array.from({ length: ROW_COUNT }, (_, i) => ({
            data: { n: i },
            geometry: JSON.stringify({ coordinates: [i % 170, i % 80], type: "Point" }),
          })),
          schemaId,
        });

        const page = await t.query(api.lib.listGeometries, {
          paginationOpts: { cursor: null, numItems: 200 },
          schemaId,
        });
        expect(page.page).toHaveLength(ROW_COUNT);
        expect(page.isDone).toBe(true);
      });

      // The budget itself: rows near the inline limit pack a page only up to
      // the byte budget — the page splits BEFORE the (much higher) row
      // ceiling and before the index runs out, reporting isDone: false, and
      // the remaining rows are still fully reachable across the cursor.
      it("pages stop at the byte budget when rows are near the inline limit, losing nothing", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Polygon"),
          ROW_COUNT = 15,
          ring = bigRing(20_000),
          geometryJson = JSON.stringify({ coordinates: [ring], type: "Polygon" }),
          rowBytes = new TextEncoder().encode(geometryJson).length;
        // Each row is comfortably inline (< INLINE_GEOMETRY_BYTE_LIMIT ≈
        // 900 KB), and the fixture is sized so the budget splits it: a page
        // holds ~11 of these rows (budget / row size — past the old 8-row
        // cap, proving the split is byte-driven) but never all 15
        // (15 × row size is over the budget).
        expect(rowBytes).toBeLessThan(INLINE_GEOMETRY_BYTE_LIMIT);
        expect(Math.floor(GEOMETRY_PAGE_BYTE_BUDGET / rowBytes)).toBeGreaterThan(8);
        expect(ROW_COUNT * rowBytes).toBeGreaterThan(GEOMETRY_PAGE_BYTE_BUDGET);

        await t.mutation(api.lib.createEntriesBulk, {
          entries: Array.from({ length: ROW_COUNT }, (_, i) => ({
            data: { n: i },
            geometry: geometryJson,
          })),
          schemaId,
        });

        const firstPage = await t.query(api.lib.listGeometries, {
          paginationOpts: { cursor: null, numItems: 200 },
          schemaId,
        });
        // Not the old fixed 8-row cap, and not the whole dataset — the byte
        // budget is what stopped it.
        expect(firstPage.page.length).toBeGreaterThan(8);
        expect(firstPage.page.length).toBeLessThan(ROW_COUNT);
        expect(firstPage.isDone).toBe(false);

        const all = await listAllGeometries(t, schemaId);
        expect(all).toHaveLength(ROW_COUNT);
      });

      // The row ceiling (`numItems` is honored only up to it) — a defensive
      // clamp, but pinned so a future budget change can't silently uncap it.
      it("numItems beyond the row ceiling is clamped", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Point"),
          ROW_COUNT = 505; // one more than the 500-row ceiling.
        await t.mutation(api.lib.createEntriesBulk, {
          entries: Array.from({ length: ROW_COUNT }, (_, i) => ({
            data: { n: i },
            geometry: JSON.stringify({ coordinates: [i % 170, i % 80], type: "Point" }),
          })),
          schemaId,
        });

        const firstPage = await t.query(api.lib.listGeometries, {
          paginationOpts: { cursor: null, numItems: 100_000 },
          schemaId,
        });
        expect(firstPage.page).toHaveLength(500);
        expect(firstPage.isDone).toBe(false);
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
      // merge — see `useGeometriesBySchemas` in the app (used by its maps
      // and group feature-layer routes).
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

  describe("entry pagination and denormalized summaries (issue #54)", () => {
    async function getSchemaEntryCount(t: TestCtx, schemaId: Id<"schemas">) {
      const doc = await t.run(async (ctx) => ctx.db.get(schemaId));
      assertDefined(doc);
      return doc.entryCount;
    }

    async function getMembershipRow(t: TestCtx, schemaId: Id<"schemas">) {
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("schemaCollections")
          .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
          .unique(),
      );
      assertDefined(row);
      return row;
    }

    it("listEntriesPage paginates newest-first through cursors", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        // One bulk seed — convex-test bumps `_creationTime` on ties in
        // insertion order, so the page order is deterministic here.
        names = ["a", "b", "c", "d", "e"];
      await t.mutation(api.lib.createEntriesBulk, {
        entries: names.map((name) => ({ data: { name } })),
        schemaId,
      });

      const page1 = await t.query(api.lib.listEntriesPage, {
        paginationOpts: { cursor: null, numItems: 3 },
        schemaId,
      });
      expect(pageNames(page1)).toStrictEqual(["e", "d", "c"]);
      expect(page1.isDone).toBe(false);

      const page2 = await t.query(api.lib.listEntriesPage, {
        paginationOpts: { cursor: page1.continueCursor, numItems: 3 },
        schemaId,
      });
      expect(pageNames(page2)).toStrictEqual(["b", "a"]);
      expect(page2.isDone).toBe(true);
    });

    it("listEntriesPage throws for a deleted schema", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t);
      await t.mutation(api.lib.deleteSchema, { schemaId });
      await expect(
        t.query(api.lib.listEntriesPage, {
          paginationOpts: { cursor: null, numItems: 10 },
          schemaId,
        }),
      ).rejects.toThrow("Schema not found");
    });

    it("entryCount stays exact across create, bulk, delete, and reset", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t);
      expect(await getSchemaEntryCount(t, schemaId)).toBe(0);

      const firstId = await t.mutation(api.lib.createEntry, {
        data: { name: "John" },
        schemaId,
      });
      expect(await getSchemaEntryCount(t, schemaId)).toBe(1);

      await t.mutation(api.lib.createEntriesBulk, {
        entries: [{ data: { name: "A" } }, { data: { name: "B" } }],
        schemaId,
      });
      expect(await getSchemaEntryCount(t, schemaId)).toBe(3);

      // A data-only UPDATE must not touch the count.
      await t.mutation(api.lib.updateEntry, { data: { name: "Johnny" }, entryId: firstId });
      expect(await getSchemaEntryCount(t, schemaId)).toBe(3);

      await t.mutation(api.lib.deleteEntry, { entryId: firstId });
      expect(await getSchemaEntryCount(t, schemaId)).toBe(2);

      await t.mutation(api.lib.deleteEntriesBySchema, { schemaId });
      expect(await getSchemaEntryCount(t, schemaId)).toBe(0);
    });

    it("addSchemaToCollection stamps the dataset kind onto the membership row", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        collectionId = await t.mutation(api.lib.createCollection, { name: "Geo collection" });
      await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
      expect((await getMembershipRow(t, schemaId)).kind).toBe("geospatial");
    });

    it("backfillDatasetSummaries repairs pre-field counts and membership kinds", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        collectionId = await t.mutation(api.lib.createCollection, { name: "Collection" });
      await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
      await t.mutation(api.lib.createEntriesBulk, {
        entries: [{ data: { name: "A" } }, { data: { name: "B" } }, { data: { name: "C" } }],
        schemaId,
      });

      // Simulate rows that predate the denormalized fields.
      await t.run(async (ctx) => {
        await ctx.db.patch(schemaId, { entryCount: undefined });
        const row = await ctx.db
          .query("schemaCollections")
          .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
          .unique();
        if (row) {
          await ctx.db.patch(row._id, { kind: undefined });
        }
      });

      const stats = await t.mutation(api.lib.backfillDatasetSummaries, {});
      expect(stats.schemasPatched).toBe(1);
      expect(stats.membershipsPatched).toBe(1);
      expect(await getSchemaEntryCount(t, schemaId)).toBe(3);
      expect((await getMembershipRow(t, schemaId)).kind).toBe("standard");
    });

    it("listEntriesForIds returns only existing entries, deduplicated", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        kept = await t.mutation(api.lib.createEntry, { data: { name: "kept" }, schemaId }),
        deleted = await t.mutation(api.lib.createEntry, { data: { name: "gone" }, schemaId });
      await t.mutation(api.lib.deleteEntry, { entryId: deleted });

      const rows = await t.query(api.lib.listEntriesForIds, {
        entryIds: [kept, deleted, kept],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]._id).toBe(kept);
    });

    it("listEntriesForIds rejects oversized id lists", async () => {
      const t = initConvexTest(),
        schemaId = await createTestSchema(t),
        entryId = await t.mutation(api.lib.createEntry, { data: { name: "x" }, schemaId });
      await expect(
        t.query(api.lib.listEntriesForIds, {
          entryIds: Array.from({ length: 201 }, () => entryId),
        }),
      ).rejects.toThrow("exceeds 200 items");
    });

    it("listEntriesByCollection limit caps rows per dataset", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        collectionId = await t.mutation(api.lib.createCollection, { name: "Collection" });
      await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
      await t.mutation(api.lib.createEntriesBulk, {
        entries: [{ data: { name: "A" } }, { data: { name: "B" } }, { data: { name: "C" } }],
        schemaId,
      });

      const capped = await t.query(api.lib.listEntriesByCollection, {
        collectionId,
        limit: 2,
      });
      expect(capped).toHaveLength(2);

      const all = await t.query(api.lib.listEntriesByCollection, { collectionId });
      expect(all).toHaveLength(3);
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
        // oxlint-disable-next-line no-await-in-loop -- each chunk needs its own storage blob before its insert action runs.
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
    // the module-scope `runConversion` helper drives the same internal batch
    // mutation page by page, as the workflow would.

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
        expect(i < 2 ? entry.geometryType : undefined).toBe(i < 2 ? "Point" : undefined);
      }

      const geometries = await listAllGeometries(t, schemaId);
      expect(geometries).toHaveLength(2);
      expect(geometries.every((g) => g.type === "Point")).toBe(true);
    });
  });

  describe("geometry simplification", () => {
    // `startSimplification`'s happy path and `simplifyGeometryWorkflow`'s
    // execution aren't unit-testable here — same workflow Engine limitation
    // as the dataset import and geospatial conversion suites above — so
    // these cover the guard, the flag storage, and the batch primitives the
    // workflow drives (`listSimplifyBatchInternal` /
    // `simplifyGeometryBatchInternal` / `applySimplifiedGeometriesInternal`),
    // plus the write-path rounding that the importer checkbox controls.
    it("createSchema stores simplifyGeometry for geospatial datasets and rejects it for standard ones", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon", { simplifyGeometry: true }),
        stored = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(stored);
      expect(stored.simplifyGeometry).toBe(true);

      await expect(
        t.mutation(api.lib.createSchema, {
          kind: "standard",
          schema: { title: "Plain", type: "object" },
          simplifyGeometry: true,
        }),
      ).rejects.toThrow("Only a geospatial dataset can simplify geometry.");
    });

    it("createEntry rounds a geometry when the dataset opts into simplification, and stores it exactly otherwise", async () => {
      const t = initConvexTest(),
        simplifiedSchemaId = await createGeospatialSchema(t, "Point", { simplifyGeometry: true }),
        exactSchemaId = await createGeospatialSchema(t, "Point"),
        geometry = { coordinates: [0.123456789, 0.987654321], type: "Point" };

      await t.mutation(api.lib.createEntry, {
        data: { n: 1 },
        geometry: JSON.stringify(geometry),
        schemaId: simplifiedSchemaId,
      });
      await t.mutation(api.lib.createEntry, {
        data: { n: 2 },
        geometry: JSON.stringify(geometry),
        schemaId: exactSchemaId,
      });

      const simplified = await listAllGeometries(t, simplifiedSchemaId),
        exact = await listAllGeometries(t, exactSchemaId),
        simplifiedRow = simplified[0],
        exactRow = exact[0];
      assertDefined(simplifiedRow);
      assertDefined(exactRow);
      assertDefined(simplifiedRow.geometryJson);
      assertDefined(exactRow.geometryJson);
      // Rounded to 6dp on the simplifying dataset…
      expect(JSON.parse(simplifiedRow.geometryJson)).toStrictEqual({
        coordinates: [0.123457, 0.987654],
        type: "Point",
      });
      // …and byte-for-byte on the dataset that didn't opt in.
      expect(JSON.parse(exactRow.geometryJson)).toStrictEqual(geometry);
    });

    it("simplifyGeometryBatchInternal rounds inline and blob-backed payloads, re-decides each row's storage form, and deletes the blob it replaced", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        noisyPoint: number[] = [0.123456789012, 0.987654321098],
        inlineGeometry = {
          coordinates: [[noisyPoint, [1, 0], [1, 1], noisyPoint]],
          type: "Polygon",
        },
        // JSON text comfortably beyond INLINE_GEOMETRY_BYTE_LIMIT, so this
        // row lands in file storage rather than inline.
        hugeRing = bigRing(70_000),
        blobGeometry = { coordinates: [hugeRing], type: "Polygon" },
        inlineStorageId = await storeRows(t, [{ data: { n: 1 }, geometry: inlineGeometry }]),
        blobStorageId = await storeRows(t, [{ data: { n: 2 }, geometry: blobGeometry }]);
      await t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId: inlineStorageId });
      await t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId: blobStorageId });

      const before = await listAllGeometries(t, schemaId);
      expect(before).toHaveLength(2);
      const blobRow = before.find((g) => g.geometryUrl !== undefined);
      assertDefined(blobRow);
      const blobGeometryStorageId = await t.run(async (ctx) => {
        const row = await ctx.db.get(blobRow._id);
        assertDefined(row);
        assertDefined(row.geometryStorageId);
        return row.geometryStorageId;
      });

      const result = await t.action(internal.lib.simplifyGeometryBatchInternal, {
        cursor: null,
        schemaId,
      });
      expect(result.isDone).toBe(true);
      expect(result.simplified).toBe(2);

      const after = await listAllGeometries(t, schemaId),
        roundedInline = after.find((g) => g._id === before[0]._id),
        roundedBlob = after.find((g) => g._id === blobRow._id);
      assertDefined(roundedInline);
      assertDefined(roundedBlob);

      // The small row stays inline, now rounded…
      assertDefined(roundedInline.geometryJson);
      const inlineParsed = JSON.parse(roundedInline.geometryJson);
      expect(inlineParsed.coordinates[0][0]).toStrictEqual([
        Math.round(noisyPoint[0] * 1e6) / 1e6,
        Math.round(noisyPoint[1] * 1e6) / 1e6,
      ]);
      // …and the big row still exceeds the inline limit, so it re-lands in a
      // NEW blob (rounded), with the old blob deleted behind it.
      const newBlobStorageId = await t.run(async (ctx) => {
        const row = await ctx.db.get(roundedBlob._id);
        assertDefined(row);
        assertDefined(row.geometryStorageId);
        return row.geometryStorageId;
      });
      expect(newBlobStorageId).not.toBe(blobGeometryStorageId);
      const replaced = await t.run(async (ctx) => ctx.storage.get(blobGeometryStorageId));
      expect(replaced).toBeNull();
      const newBlobJson: unknown = await t.run(async (ctx) => {
        const blob = await ctx.storage.get(newBlobStorageId);
        assertDefined(blob);
        return JSON.parse(await blob.text());
      });
      expect((newBlobJson as typeof blobGeometry).coordinates[0][0]).toStrictEqual([
        Math.round(hugeRing[0][0] * 1e6) / 1e6,
        Math.round(hugeRing[0][1] * 1e6) / 1e6,
      ]);
    });

    it("startSimplification rejects a standard dataset", async () => {
      const t = initConvexTest(),
        schemaId = await createImportSchema(t);
      await expect(t.mutation(api.lib.startSimplification, { schemaId, total: 1 })).rejects.toThrow(
        "Only a geospatial dataset can simplify geometry.",
      );
    });

    it("deleteSchema also deletes the retained source-file blob", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Polygon"),
        sourceFileStorageId = await t.run(async (ctx) =>
          ctx.storage.store(new Blob(["original bytes"], { type: "application/json" })),
        );
      await t.run(async (ctx) => {
        await ctx.db.patch(schemaId, { sourceFileStorageId });
      });

      await t.mutation(api.lib.deleteSchema, { schemaId });

      const stillThere = await t.run(async (ctx) => ctx.storage.get(sourceFileStorageId));
      expect(stillThere).toBeNull();
    });
  });

  describe("map tile archive versioning", () => {
    // Every geometry-affecting write bumps `mapTileCacheVersion` (absent
    // reads as 0) so the rebuild worker's expectedVersion guard can detect a
    // stale rebuild. "Geometry-affecting" = the paths that already maintain
    // `featureCount`/`boundingBox` (via `applyGeometryStatsDelta`) plus
    // simplify batches and `deleteEntriesBySchema` — NOT data-only property
    // edits, which never touch stored coordinates.
    async function versionOf(t: TestCtx, schemaId: Id<"schemas">): Promise<number | undefined> {
      const schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      return schemaDoc.mapTileCacheVersion;
    }

    it("MAP_TILE_ARCHIVE_MIN_BYTES pins the 256 KB threshold", () => {
      expect(MAP_TILE_ARCHIVE_MIN_BYTES).toBe(262_144);
    });

    it("bumps the version on insert -> replace -> clear -> delete, not on data-only edits", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        pointA = { coordinates: [0, 0], type: "Point" },
        pointB = { coordinates: [1, 1], type: "Point" },
        entryId = await t.mutation(api.lib.createEntry, {
          data: { n: 1 },
          geometry: JSON.stringify(pointA),
          schemaId,
        });

      expect(await versionOf(t, schemaId)).toBe(1);

      // A data-only edit (no `geometry` arg) never touches coordinates.
      await t.mutation(api.lib.updateEntry, { data: { n: 2 }, entryId });
      expect(await versionOf(t, schemaId)).toBe(1);

      await t.mutation(api.lib.updateEntry, {
        data: { n: 2 },
        entryId,
        geometry: JSON.stringify(pointB),
      });
      expect(await versionOf(t, schemaId)).toBe(2);

      await t.mutation(api.lib.updateEntry, { data: { n: 2 }, entryId, geometry: null });
      expect(await versionOf(t, schemaId)).toBe(3);

      // Deleting an entry whose geometry is ALREADY gone is not
      // geometry-affecting (nothing maintains featureCount/boundingBox) —
      // no bump. Deleting one that still has a geometry is.
      const secondId = await t.mutation(api.lib.createEntry, {
        data: { n: 3 },
        geometry: JSON.stringify(pointA),
        schemaId,
      });
      expect(await versionOf(t, schemaId)).toBe(4);

      await t.mutation(api.lib.deleteEntry, { entryId });
      expect(await versionOf(t, schemaId)).toBe(4);

      await t.mutation(api.lib.deleteEntry, { entryId: secondId });
      expect(await versionOf(t, schemaId)).toBe(5);
    });

    it("a legacy row with an absent version field bumps from 0, and standard datasets stay at 0", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point");
      // Never written since the field existed: version is absent…
      expect(await versionOf(t, schemaId)).toBeUndefined();

      // …and the first geometry write lands at 1, not 2.
      await t.mutation(api.lib.createEntry, {
        data: { n: 1 },
        geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }),
        schemaId,
      });
      expect(await versionOf(t, schemaId)).toBe(1);

      // A standard dataset's entries carry no geometry — no bumps, ever.
      const standardId = await createTestSchema(t);
      await t.mutation(api.lib.createEntry, { data: { name: "plain" }, schemaId: standardId });
      expect(await versionOf(t, standardId)).toBeUndefined();
    });

    it("bumps once per import chunk (insertEntriesChunkInternal) and once per simplify batch", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        point = { coordinates: [0.5, 0.5], type: "Point" };

      await t.mutation(internal.lib.insertEntriesChunkInternal, {
        dataArray: [
          {
            data: { n: 1 },
            resolvedGeometry: { geometryJson: JSON.stringify(point), type: "Point" },
          },
          {
            data: { n: 2 },
            resolvedGeometry: { geometryJson: JSON.stringify(point), type: "Point" },
          },
        ],
        schemaId,
      });
      const afterChunkOne = await versionOf(t, schemaId);
      expect(afterChunkOne).toBe(1);

      await t.mutation(internal.lib.insertEntriesChunkInternal, {
        dataArray: [
          {
            data: { n: 3 },
            resolvedGeometry: { geometryJson: JSON.stringify(point), type: "Point" },
          },
        ],
        schemaId,
      });
      expect(await versionOf(t, schemaId)).toBe(2);

      // The simplify path rewrites geometry payloads directly (not through
      // applyGeometryStatsDelta) — it must bump too. Driven on a FRESH
      // dataset seeded with one noisy row, exactly as the workflow step
      // would call it, so the batch touches exactly one row.
      const simplifySchemaId = await createGeospatialSchema(t, "Point"),
        noisyStorageId = await storeRows(t, [
          {
            data: { n: 9 },
            geometry: { coordinates: [0.123456789012, 0.987654321098], type: "Point" },
          },
        ]);
      await t.action(internal.lib.insertChunkFromStorage, {
        schemaId: simplifySchemaId,
        storageId: noisyStorageId,
      });
      expect(await versionOf(t, simplifySchemaId)).toBe(1);

      const result = await t.action(internal.lib.simplifyGeometryBatchInternal, {
        cursor: null,
        schemaId: simplifySchemaId,
      });
      expect(result.simplified).toBe(1);
      expect(await versionOf(t, simplifySchemaId)).toBe(2);
    });

    it("deleteEntriesBySchema deletes the archive blob and resets all four cache fields", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point");
      await t.mutation(api.lib.createEntry, {
        data: { n: 1 },
        geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }),
        schemaId,
      });
      const archiveStorageId = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["pmtiles"], { type: "application/octet-stream" })),
      );
      await t.mutation(api.lib.setMapTileArchive, {
        bytes: 7,
        expectedVersion: 1,
        maxZoom: 14,
        schemaId,
        storageId: archiveStorageId,
      });
      assertDefined(await t.query(api.lib.getMapTileArchiveMeta, { schemaId }));

      await t.mutation(api.lib.deleteEntriesBySchema, { schemaId });

      const schemaDoc = await t.query(api.lib.getSchema, { schemaId });
      assertDefined(schemaDoc);
      expect(schemaDoc.mapTileArchiveStorageId).toBeUndefined();
      expect(schemaDoc.mapTileArchiveBytes).toBeUndefined();
      expect(schemaDoc.mapTileArchiveMaxZoom).toBeUndefined();
      expect(schemaDoc.mapTileArchiveBuiltVersion).toBeUndefined();
      expect(schemaDoc.mapTileCacheVersion).toBeUndefined();
      expect(await t.query(api.lib.getMapTileArchiveMeta, { schemaId })).toBeNull();
      const stillThere = await t.run(async (ctx) => ctx.storage.get(archiveStorageId));
      expect(stillThere).toBeNull();
    });

    it("deleteSchema also deletes the installed archive blob", async () => {
      const t = initConvexTest(),
        schemaId = await createGeospatialSchema(t, "Point"),
        archiveStorageId = await t.run(async (ctx) =>
          ctx.storage.store(new Blob(["pmtiles"], { type: "application/octet-stream" })),
        );
      await t.mutation(api.lib.setMapTileArchive, {
        bytes: 7,
        expectedVersion: 0,
        maxZoom: 14,
        schemaId,
        storageId: archiveStorageId,
      });

      await t.mutation(api.lib.deleteSchema, { schemaId });

      const stillThere = await t.run(async (ctx) => ctx.storage.get(archiveStorageId));
      expect(stillThere).toBeNull();
    });

    describe("setMapTileArchive", () => {
      it("installs onto a never-written (legacy, absent-version) row at expectedVersion 0 and serves the meta shape", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Point"),
          storageId = await installArchive(t, schemaId, 0, "legacy-archive");

        // Absent-version rows read as version 0, so the install matches —
        // and writes the version explicitly, keeping "archive present ⇒
        // version present" for the meta query.
        const meta = await t.query(api.lib.getMapTileArchiveMeta, { schemaId });
        assertDefined(meta);
        expect(meta.storageId).toBe(storageId);
        expect(meta.version).toBe(0);
        expect(meta.bytes).toBe("legacy-archive".length);
        expect(meta.maxZoom).toBe(12);
        expect(meta.url).toBeTruthy();
      });

      it("makes an archive observably stale when edits land after its install", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Point"),
          storageId = await installArchive(t, schemaId, 0, "built-at-0");

        // Fresh install: built-at version equals the live counter.
        const before = await t.query(api.lib.getMapTileArchiveMeta, { schemaId });
        assertDefined(before);
        expect(before.version).toBe(0);
        const rowBefore = await t.query(api.lib.getSchema, { schemaId });
        assertDefined(rowBefore);
        expect(rowBefore.mapTileCacheVersion).toBe(0);

        await t.mutation(api.lib.createEntry, {
          data: { n: 1 },
          geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }),
          schemaId,
        });

        // The edit bumped the row's counter but not the archive's built-at
        // snapshot — meta.version falls behind, which the rebuild worker's
        // stale-on-view trigger reads as "rebuild".
        const meta = await t.query(api.lib.getMapTileArchiveMeta, { schemaId });
        assertDefined(meta);
        expect(meta.storageId).toBe(storageId);
        expect(meta.version).toBe(0);
        const row = await t.query(api.lib.getSchema, { schemaId });
        assertDefined(row);
        expect(row.mapTileCacheVersion).toBe(1);
      });

      it("re-installing at the same version deletes the superseded blob and repoints the meta", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Point"),
          firstId = await installArchive(t, schemaId, 0, "first-archive"),
          secondId = await installArchive(t, schemaId, 0, "second-archive");

        expect(secondId).not.toBe(firstId);
        const replaced = await t.run(async (ctx) => ctx.storage.get(firstId));
        expect(replaced).toBeNull();

        const meta = await t.query(api.lib.getMapTileArchiveMeta, { schemaId });
        assertDefined(meta);
        expect(meta.storageId).toBe(secondId);
      });

      it("a stale expectedVersion discards the incoming blob and leaves the row untouched", async () => {
        const t = initConvexTest(),
          schemaId = await createGeospatialSchema(t, "Point");
        await t.mutation(api.lib.createEntry, {
          data: { n: 1 },
          geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }),
          schemaId,
        });
        const currentId = await installArchive(t, schemaId, 1, "current-archive");
        const before = await t.query(api.lib.getSchema, { schemaId });
        assertDefined(before);

        // The rebuild started at version 1, but a second edit bumped the
        // row to 2 while it generated — installing at 1 must self-discard.
        await t.mutation(api.lib.createEntry, {
          data: { n: 2 },
          geometry: JSON.stringify({ coordinates: [1, 1], type: "Point" }),
          schemaId,
        });
        const staleId = await installArchive(t, schemaId, 1, "stale-archive");

        const discarded = await t.run(async (ctx) => ctx.storage.get(staleId));
        expect(discarded).toBeNull();
        const after = await t.query(api.lib.getSchema, { schemaId });
        assertDefined(after);
        expect(after.mapTileArchiveStorageId).toBe(currentId);
        expect(after.mapTileCacheVersion).toBe(2);
        expect(after.mapTileArchiveBytes).toBe(before.mapTileArchiveBytes);

        const meta = await t.query(api.lib.getMapTileArchiveMeta, { schemaId });
        assertDefined(meta);
        expect(meta.storageId).toBe(currentId);
        // `version` is the BUILT-at version of the surviving archive (1) —
        // behind the row's live counter (2), which is exactly the signal a
        // consumer uses to detect that edits landed after the install.
        expect(meta.version).toBe(1);
      });

      it("discards the incoming blob when the schema row itself is gone", async () => {
        const t = initConvexTest(),
          schemaId = await createTestSchema(t),
          storageId = await t.run(async (ctx) =>
            ctx.storage.store(new Blob(["orphan"], { type: "application/octet-stream" })),
          );
        await t.mutation(api.lib.deleteSchema, { schemaId });

        await t.mutation(api.lib.setMapTileArchive, {
          bytes: 6,
          expectedVersion: 0,
          maxZoom: 12,
          schemaId,
          storageId,
        });

        const stillThere = await t.run(async (ctx) => ctx.storage.get(storageId));
        expect(stillThere).toBeNull();
      });

      it("a dataset with no archive (and its untouched legacy rows) reads as null meta", async () => {
        const t = initConvexTest(),
          legacyId = await createGeospatialSchema(t, "Point");
        // Write some geometry so the row is not brand new, but never install
        // an archive — absent fields must read as "row path only".
        await t.mutation(api.lib.createEntry, {
          data: { n: 1 },
          geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }),
          schemaId: legacyId,
        });

        expect(await t.query(api.lib.getMapTileArchiveMeta, { schemaId: legacyId })).toBeNull();

        const missingId = await createTestSchema(t);
        await t.mutation(api.lib.deleteSchema, { schemaId: missingId });
        expect(await t.query(api.lib.getMapTileArchiveMeta, { schemaId: missingId })).toBeNull();
      });
    });
  });
});

describe("createSchema actor stamping", () => {
  it("stores the host's actor id as createdBy when one is passed", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        actorId: "user-123",
        schema: { properties: { n: { type: "number" } }, title: "Authored", type: "object" },
      }),
      doc = await t.query(api.lib.getSchema, { schemaId });

    expect(doc !== null && doc.createdBy).toBe("user-123");
  });

  it("leaves createdBy absent when no actor is passed (host flows, pre-field rows)", async () => {
    const t = initConvexTest(),
      schemaId = await createTestSchema(t),
      doc = await t.query(api.lib.getSchema, { schemaId });

    expect(doc === null ? undefined : doc.createdBy).toBeUndefined();
  });
});

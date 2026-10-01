import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/// <reference types="vite/client" />

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

/**
 * Import/simplify/schema-update pipeline integrity (issue #129):
 *
 * - a malformed chunk FAILS its step instead of reading as zero rows, and
 *   the workflow's completion gate refuses `processed !== total`;
 * - a replayed chunk step inserts NO duplicates (the per-chunk completion
 *   journal on the `imports` doc), and a failed attempt deletes the
 *   geometry blobs its rows never landed;
 * - the tile-cache version is MONOTONIC — clearing and re-importing never
 *   reuses a version, so a pre-clear archive rebuild can't pass the
 *   `setMapTileArchive` expectedVersion guard;
 * - `updateSchema` on a frozen/bound dataset rejects schema/uiSchema
 *   changes (metadata edits stay allowed) and re-syncs the `references`
 *   table when `x-reference` fields change;
 * - the minor guards: validated `total`, one data run per dataset, an
 *   `entries.data` size cap, `imports` cleanup on deleteSchema, and
 *   createSchema's null-schema ConvexError.
 *
 * NOTE (same caveat as lib.test.ts's dataset-import suite): the durable
 * workflow ENGINE is not executable under convex-test, so the import
 * workflow's end-to-end run isn't driven here — its steps and gates are
 * verified as the primitives the workflow calls, which is where every
 * behavior above lives.
 */

type TestHarness = ReturnType<typeof initConvexTest>;

function assertDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be defined");
  }
}

/** Runs everything scheduled (`runAfter(0, …)` continuations) until none are left. */
async function drainScheduled(t: TestHarness): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

async function storeRows(t: TestHarness, rows: unknown[]): Promise<Id<"_storage">> {
  return t.run(async (ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(rows)], { type: "application/json" })),
  );
}

async function storeRawBlob(t: TestHarness, text: string): Promise<Id<"_storage">> {
  return t.run(async (ctx) => ctx.storage.store(new Blob([text], { type: "application/json" })));
}

/** Total number of file-storage blobs (component storage is namespaced). */
async function storageBlobCount(t: TestHarness): Promise<number> {
  return t.run(async (ctx) => {
    let count = 0;
    for await (const _doc of ctx.db.system.query("_storage")) {
      count += 1;
    }
    return count;
  });
}

/** Inserts an `imports` status doc directly — `startImport` would kick off the (untestable) workflow engine. */
async function seedImportDoc(
  t: TestHarness,
  schemaId: Id<"schemas">,
  fields: { status?: "failed" | "pending" | "processing"; total: number },
): Promise<Id<"imports">> {
  return t.run(async (ctx) =>
    ctx.db.insert("imports", {
      processed: 0,
      schemaId,
      status: fields.status ?? "processing",
      total: fields.total,
    }),
  );
}

/** Every reference row sourced from `schemaId`. */
async function referencesFromSchema(t: TestHarness, schemaId: Id<"schemas">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("references")
      .withIndex("by_source_schema", (q) => q.eq("sourceSchemaId", schemaId))
      .collect(),
  );
}

async function schemaWithTitle(title: string, properties?: Record<string, unknown>) {
  return { properties, title, type: "object" };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chunk integrity (issue #129)", () => {
  it("a malformed (non-array) chunk fails its step instead of counting as zero rows", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      }),
      storageId = await storeRawBlob(t, JSON.stringify({ hello: "world" }));

    await expect(
      t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId }),
    ).rejects.toThrow(/malformed/);

    const entries = await t.query(api.lib.listEntries, { limit: 500, schemaId });
    expect(entries).toHaveLength(0);
  });

  it("a replayed chunk step inserts no duplicates and still reports the recorded row count", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      }),
      importId = await seedImportDoc(t, schemaId, { total: 2 }),
      storageId = await storeRows(t, [{ data: { name: "a" } }, { data: { name: "b" } }]),
      stepArgs = { chunkIndex: 0, importId, schemaId, storageId };

    const first: number = await t.action(internal.lib.insertChunkFromStorage, stepArgs);
    expect(first).toBe(2);
    // The completion journal records the chunk atomically with its inserts.
    const doc = await t.query(api.lib.getImportStatus, { importId });
    assertDefined(doc);
    expect(doc.completedChunks).toStrictEqual([{ index: 0, rows: 2 }]);

    // The replay: same step, same args — the rows are already in, so this
    // must be a no-op that returns the recorded count.
    const second: number = await t.action(internal.lib.insertChunkFromStorage, stepArgs);
    expect(second).toBe(2);
    expect(await t.query(api.lib.listEntries, { limit: 500, schemaId })).toHaveLength(2);
    const after = await t.query(api.lib.getImportStatus, { importId });
    assertDefined(after);
    expect(after.completedChunks).toStrictEqual([{ index: 0, rows: 2 }]);
  });

  it("a failing row deletes the geometry blobs its chunk stored, instead of orphaning them", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        geometryType: "Polygon",
        kind: "geospatial",
        schema: await schemaWithTitle("Geospatial Schema"),
      });
    // Row 0's ring serializes past the inline limit → a file-storage blob;
    // row 1 is structurally invalid → the chunk fails after that blob was
    // stored. 1 chunk blob before the action runs; the geometry blob is
    // created and cleaned up inside it.
    const bigRing: number[][] = [];
    for (let i = 0; i < 70_000; i += 1) {
      const angle = (2 * Math.PI * i) / 69_999;
      bigRing.push([
        Number((Math.cos(angle) * 0.01).toFixed(6)),
        Number((Math.sin(angle) * 0.01).toFixed(6)),
      ]);
    }
    bigRing.push(bigRing[0]);
    const storageId = await storeRows(t, [
      { data: { n: 1 }, geometry: { coordinates: [bigRing], type: "Polygon" } },
      { data: { n: 2 }, geometry: { coordinates: [200, 0], type: "Point" } },
    ]);
    expect(await storageBlobCount(t)).toBe(1);

    await expect(
      t.action(internal.lib.insertChunkFromStorage, { schemaId, storageId }),
    ).rejects.toThrow(/Row 1/);

    // The chunk blob survives (failure cleanup is handleImportComplete's
    // job); the geometry blob its rows never landed is GONE.
    expect(await storageBlobCount(t)).toBe(1);
    expect(await t.query(api.lib.listEntries, { limit: 500, schemaId })).toHaveLength(0);
  });

  it("the completion gate marks completed only when processed equals total", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      }),
      importId = await seedImportDoc(t, schemaId, { total: 5 });

    await expect(
      t.mutation(internal.lib.completeImport, { importId, processed: 3, total: 5 }),
    ).rejects.toThrow(/3 of 5/);

    await t.mutation(internal.lib.completeImport, { importId, processed: 5, total: 5 });
    const doc = await t.query(api.lib.getImportStatus, { importId });
    assertDefined(doc);
    expect(doc.status).toBe("completed");
    expect(doc.processed).toBe(5);
  });

  it("handleImportComplete records the failure and deletes the leftover chunk blobs", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      }),
      importId = await seedImportDoc(t, schemaId, { total: 1 }),
      leftoverId = await storeRows(t, [{ name: "never-processed" }]);

    await t.mutation(internal.lib.handleImportComplete, {
      context: { importId, storageIds: [leftoverId] },
      result: { kind: "error", error: "Row 0 is not an object." },
      workflowId: "wf-test",
    });

    const doc = await t.query(api.lib.getImportStatus, { importId });
    assertDefined(doc);
    expect(doc.status).toBe("failed");
    expect(doc.error).toBe("Row 0 is not an object.");
    expect(await t.run(async (ctx) => ctx.storage.get(leftoverId))).toBeNull();
  });
});

describe("monotonic tile-cache version (issue #129)", () => {
  it("clearing and re-importing never reuses a tile cache version, and a pre-clear rebuild self-discards", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        geometryType: "Point",
        kind: "geospatial",
        schema: await schemaWithTitle("Geospatial Schema"),
      });

    await t.mutation(api.lib.createEntry, {
      data: { n: 1 },
      geometry: JSON.stringify({ coordinates: [0, 0], type: "Point" }),
      schemaId,
    });
    const archiveId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["archive-v1"], { type: "application/octet-stream" })),
    );
    await t.mutation(api.lib.setMapTileArchive, {
      bytes: 10,
      expectedVersion: 1,
      maxZoom: 12,
      schemaId,
      storageId: archiveId,
    });
    assertDefined(await t.query(api.lib.getMapTileArchiveMeta, { schemaId }));

    // Clear: the version is retired (bumped to 2), never reset to 0/1.
    await t.mutation(api.lib.deleteEntriesBySchema, { schemaId });
    const afterClear = await t.query(api.lib.getSchema, { schemaId });
    assertDefined(afterClear);
    expect(afterClear.mapTileCacheVersion).toBe(2);
    expect(await t.query(api.lib.getMapTileArchiveMeta, { schemaId })).toBeNull();

    // A rebuild that started against pre-clear data (snapshot version 1)
    // arrives late and self-discards: the guard no longer passes.
    const staleArchiveId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["stale"], { type: "application/octet-stream" })),
    );
    await t.mutation(api.lib.setMapTileArchive, {
      bytes: 5,
      expectedVersion: 1,
      maxZoom: 12,
      schemaId,
      storageId: staleArchiveId,
    });
    expect(await t.query(api.lib.getMapTileArchiveMeta, { schemaId })).toBeNull();
    expect(await t.run(async (ctx) => ctx.storage.get(staleArchiveId))).toBeNull();

    // Re-import climbs monotonically (3), never back to a retired version.
    await t.mutation(internal.lib.insertEntriesChunkInternal, {
      dataArray: [
        {
          data: { n: 2 },
          resolvedGeometry: {
            geometryJson: JSON.stringify({ coordinates: [1, 1], type: "Point" }),
            type: "Point",
          },
        },
      ],
      schemaId,
    });
    const afterReimport = await t.query(api.lib.getSchema, { schemaId });
    assertDefined(afterReimport);
    expect(afterReimport.mapTileCacheVersion).toBe(3);

    // A FRESH rebuild at the current version installs normally — the guard
    // design itself is untouched.
    const freshArchiveId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["fresh"], { type: "application/octet-stream" })),
    );
    await t.mutation(api.lib.setMapTileArchive, {
      bytes: 5,
      expectedVersion: 3,
      maxZoom: 12,
      schemaId,
      storageId: freshArchiveId,
    });
    assertDefined(await t.query(api.lib.getMapTileArchiveMeta, { schemaId }));
  });
});

describe("updateSchema integrity (issue #129)", () => {
  const LIVE_SCHEMA = {
    properties: { label: { title: "Location", type: "string" } },
    required: ["label"],
    title: "Restaurant locations",
    type: "object",
  };

  async function createBoundSchemas(t: TestHarness) {
    const liveId = await t.mutation(api.lib.createSchema, {
      geometryType: "Point",
      kind: "geospatial",
      schema: LIVE_SCHEMA,
      source: { name: "restaurantLocations" },
    });
    const versionId = await t.mutation(api.lib.createSchema, {
      geometryType: "Point",
      kind: "geospatial",
      lineage: { frozenAt: Date.now(), sourceSchemaId: liveId, versionLabel: "v1" },
      schema: LIVE_SCHEMA,
    });
    return { liveId, versionId };
  }

  it("rejects schema and uiSchema changes on a frozen version, while metadata edits stay allowed", async () => {
    const t = initConvexTest(),
      { versionId } = await createBoundSchemas(t);

    await expect(
      t.mutation(api.lib.updateSchema, {
        schema: { properties: { label: { type: "string" } }, title: "Rewritten", type: "object" },
        schemaId: versionId,
      }),
    ).rejects.toThrow("read-only projection");
    await expect(
      t.mutation(api.lib.updateSchema, { schemaId: versionId, uiSchema: { label: {} } }),
    ).rejects.toThrow("read-only projection");

    // Metadata-only edits stay allowed on purpose (the recorded behavior
    // bound-write.test.ts pins).
    await t.mutation(api.lib.updateSchema, { schemaId: versionId, title: "Renamed version" });
    const doc = await t.query(api.lib.getSchema, { schemaId: versionId });
    assertDefined(doc);
    expect(doc.title).toBe("Renamed version");
  });

  it("accepts an attested schema migration on a bound dataset (the sync engine's path)", async () => {
    const t = initConvexTest(),
      { liveId } = await createBoundSchemas(t);

    await t.mutation(api.lib.updateSchema, {
      boundWrite: "sync",
      schema: { ...LIVE_SCHEMA, description: "migrated by sync" },
      schemaId: liveId,
    });
    const doc = await t.query(api.lib.getSchema, { schemaId: liveId });
    assertDefined(doc);
    expect(doc.description).toBe("migrated by sync");
  });

  it("reference rows follow x-reference edits (scheduled re-index)", async () => {
    const t = initConvexTest(),
      targetId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("States"),
      }),
      sourceId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Deployments", {
          link: { type: "string" },
          name: { type: "string" },
        }),
      }),
      targetEntryId = await t.mutation(api.lib.createEntry, {
        data: { name: "California" },
        schemaId: targetId,
      }),
      sourceEntryId = await t.mutation(api.lib.createEntry, {
        data: { link: targetEntryId, name: "Deployment 1" },
        schemaId: sourceId,
      });

    // No x-reference yet: the entry's link value is inert.
    expect(await referencesFromSchema(t, sourceId)).toHaveLength(0);

    // Add the reference annotation — the scheduled re-index derives the row.
    await t.mutation(api.lib.updateSchema, {
      schema: await schemaWithTitle("Deployments", {
        link: {
          type: "string",
          "x-reference": { cardinality: "one", datasetId: targetId },
        },
        name: { type: "string" },
      }),
      schemaId: sourceId,
    });
    await drainScheduled(t);

    const refs = await referencesFromSchema(t, sourceId);
    expect(refs).toHaveLength(1);
    expect(refs[0].fieldName).toBe("link");
    expect(refs[0].sourceEntryId).toBe(sourceEntryId);
    expect(refs[0].targetEntryId).toBe(targetEntryId);

    // Remove it again — the stale row is wiped.
    await t.mutation(api.lib.updateSchema, {
      schema: await schemaWithTitle("Deployments", {
        link: { type: "string" },
        name: { type: "string" },
      }),
      schemaId: sourceId,
    });
    await drainScheduled(t);
    expect(await referencesFromSchema(t, sourceId)).toHaveLength(0);
  });

  it("skips the re-index walk when neither schema version mentions x-reference", async () => {
    const t = initConvexTest(),
      sourceId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Plain", { name: { type: "string" } }),
      });

    // Draining after the edit must have nothing to do and nothing to break.
    await t.mutation(api.lib.updateSchema, {
      schema: await schemaWithTitle("Renamed", { name: { type: "string" } }),
      schemaId: sourceId,
    });
    await drainScheduled(t);
    expect(await referencesFromSchema(t, sourceId)).toHaveLength(0);
  });
});

describe("minor guards (issue #129)", () => {
  it("createSchema rejects a null schema with a ConvexError, not a TypeError", async () => {
    const t = initConvexTest();
    await expect(t.mutation(api.lib.createSchema, { schema: null })).rejects.toThrow(
      /must be an object/,
    );
  });

  it("startImport validates total as a non-negative integer", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      });

    await expect(
      t.mutation(api.lib.startImport, { chunks: [], schemaId, total: -1 }),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      t.mutation(api.lib.startImport, { chunks: [], schemaId, total: 1.5 }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it("only one data run per dataset at a time", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      });
    await seedImportDoc(t, schemaId, { status: "processing", total: 0 });

    await expect(
      t.mutation(api.lib.startImport, { chunks: [], schemaId, total: 0 }),
    ).rejects.toThrow(/already running/);
  });

  it("entries.data is capped server-side", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      });

    await expect(
      t.mutation(api.lib.createEntry, {
        data: { blob: "x".repeat(1_100_000) },
        schemaId,
      }),
    ).rejects.toThrow(/byte limit/);
  });

  it("deleteSchema cleans up the dataset's imports rows and their leftover chunk blobs", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Import Schema"),
      }),
      importId = await seedImportDoc(t, schemaId, { status: "failed", total: 3 }),
      leftoverId = await storeRows(t, [{ name: "orphan-chunk" }]);
    await t.run(async (ctx) => {
      await ctx.db.patch(importId, { storageIds: [leftoverId] });
    });

    await t.mutation(api.lib.deleteSchema, { schemaId });
    await drainScheduled(t);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(importId)).toBeNull();
      expect(await ctx.storage.get(leftoverId)).toBeNull();
    });
  });

  it("setSchemaLifecycle flips an import draft to published but refuses bound datasets", async () => {
    const t = initConvexTest(),
      draftId = await t.mutation(api.lib.createSchema, {
        actorId: "creator-1",
        lifecycle: "draft",
        schema: await schemaWithTitle("Draft"),
      }),
      boundId = await t.mutation(api.lib.createSchema, {
        schema: await schemaWithTitle("Bound"),
        source: { name: "feed" },
      });

    // A draft is invisible in the catalog until published…
    const drafts = await t.query(api.lib.listDraftSchemaSummaries, {
      limit: 100,
      viewerId: "creator-1",
    });
    expect(drafts.map((doc) => doc._id)).toContain(draftId);
    await t.mutation(api.lib.setSchemaLifecycle, { lifecycle: "published", schemaId: draftId });
    const published = await t.query(api.lib.listDraftSchemaSummaries, {
      limit: 100,
      viewerId: "creator-1",
    });
    expect(published.map((doc) => doc._id)).not.toContain(draftId);

    // …while a bound dataset's lifecycle belongs to its sync flow.
    await expect(
      t.mutation(api.lib.setSchemaLifecycle, { lifecycle: "published", schemaId: boundId }),
    ).rejects.toThrow(/managed by its source sync flow/);
  });
});

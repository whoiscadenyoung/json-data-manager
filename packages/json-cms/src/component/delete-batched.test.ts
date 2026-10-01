/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

/**
 * The batched, budget-aware delete drain (issue #128): deleting and clearing
 * a dataset of more than 10k entries WITH geometry must succeed — the old
 * single-transaction `.collect()`-and-delete blew Convex's per-transaction
 * caps (≈16k writes / 32k reads / 16 MiB read) at roughly 8k entries — and
 * leave no `entries`/`geometries`/`references`/`schemaCollections` rows
 * behind, with the schema row deleted last (a clear resets it instead).
 */

type TestHarness = ReturnType<typeof initConvexTest>;

/** Runs everything the drain scheduled (`runAfter(0, …)` continuations) until none are left. */
async function drainScheduled(t: TestHarness): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

const ENTRY_COUNT = 10_500, // comfortably past the ~8k failure threshold
  BULK = 500; // rows per seeding mutation (each bulk insert stays one transaction)

/** Seeds a geospatial dataset with `count` rows, each carrying a real (if small) Point geometry, plus one collection membership. */
async function seedBigDataset(t: TestHarness, count: number): Promise<Id<"schemas">> {
  const schemaId = await t.mutation(api.lib.createSchema, {
      geometryType: "Point",
      kind: "geospatial",
      schema: { title: "Big geospatial dataset", type: "object" },
    }),
    collectionId = await t.mutation(api.lib.createCollection, { name: "Big" });
  await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
  let inserted = 0;
  while (inserted < count) {
    const rows = Array.from({ length: Math.min(BULK, count - inserted) }, (_, i) => ({
      data: { index: inserted + i },
      // A real geometry per row, so the drain carries the geometry-row
      // cascade for every batch.
      geometry: JSON.stringify({
        coordinates: [(inserted + i) % 180, (inserted + i) % 90],
        type: "Point",
      }),
    }));
    // oxlint-disable-next-line no-await-in-loop -- one transaction per seeding batch.
    await t.mutation(api.lib.createEntriesBulk, { entries: rows, schemaId });
    inserted += rows.length;
  }
  return schemaId;
}

/** The delete drain must leave NOTHING behind: no rows in any child table, and the schema row itself gone. */
async function assertSchemaFullyGone(t: TestHarness, schemaId: Id<"schemas">): Promise<void> {
  await t.run(async (ctx) => {
    expect(await ctx.db.get(schemaId)).toBeNull();
    expect(
      await ctx.db
        .query("entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
        .take(1),
    ).toStrictEqual([]);
    expect(
      await ctx.db
        .query("geometries")
        .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
        .take(1),
    ).toStrictEqual([]);
    expect(
      await ctx.db
        .query("references")
        .withIndex("by_source_schema", (q) => q.eq("sourceSchemaId", schemaId))
        .take(1),
    ).toStrictEqual([]);
    expect(
      await ctx.db
        .query("schemaCollections")
        .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
        .take(1),
    ).toStrictEqual([]);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("batched deletes (issue #128)", () => {
  it(
    "deleteSchema removes a >10k-entry geospatial dataset with geometry, leaving nothing behind",
    { timeout: 240_000 },
    async () => {
      const t = initConvexTest(),
        schemaId = await seedBigDataset(t, ENTRY_COUNT);

      const doc = await t.run(async (ctx) => ctx.db.get(schemaId));
      if (doc === null) {
        throw new Error("seed failed");
      }
      expect(doc.entryCount).toBe(ENTRY_COUNT);

      await t.mutation(api.lib.deleteSchema, { schemaId });
      // Small drains complete inside the calling mutation; a big one
      // schedules its continuation — either way this converges.
      await drainScheduled(t);
      await assertSchemaFullyGone(t, schemaId);
    },
  );

  it(
    "deleteEntriesBySchema clears a >10k-entry geospatial dataset with geometry and resets the row",
    { timeout: 240_000 },
    async () => {
      const t = initConvexTest(),
        schemaId = await seedBigDataset(t, ENTRY_COUNT);

      const cleared = await t.mutation(api.lib.deleteEntriesBySchema, { schemaId });
      await drainScheduled(t);

      expect(cleared).toBe(ENTRY_COUNT);
      await t.run(async (ctx) => {
        expect(
          await ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .take(1),
        ).toStrictEqual([]);
        expect(
          await ctx.db
            .query("geometries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .take(1),
        ).toStrictEqual([]);
        // The dataset itself SURVIVES a clear, with its counters reset and
        // the summary fields back to a clean slate.
        const doc = await ctx.db.get(schemaId);
        if (doc === null) {
          throw new Error("clear deleted the schema row — it must survive");
        }
        expect(doc.entryCount).toBe(0);
        expect(doc.featureCount).toBe(0);
        expect(doc.boundingBox).toBeUndefined();
        expect(doc.mapTileCacheVersion).toBeUndefined();
      });
    },
  );

  it(
    "the scheduled continuation steps are the same machinery and converge on their own",
    { timeout: 120_000 },
    async () => {
      // Calling a step directly proves it carries the FULL drain (its own
      // phases plus the finisher), so a rescheduled mid-drain hop — whatever
      // phase it resumes at — always drives to completion. A small fixture
      // suffices: the step drains its whole phase list in one call here.
      const t = initConvexTest(),
        deleteId = await seedBigDataset(t, 250);
      await t.mutation(internal.lib.deleteSchemaStep, { phase: "entries", schemaId: deleteId });
      await drainScheduled(t);
      await assertSchemaFullyGone(t, deleteId);

      const clearId = await seedBigDataset(t, 250);
      await t.mutation(internal.lib.clearEntriesStep, { phase: "entries", schemaId: clearId });
      await drainScheduled(t);
      const doc = await t.run(async (ctx) => ctx.db.get(clearId));
      if (doc === null) {
        throw new Error("clear step deleted the schema row — it must survive");
      }
      expect(doc.entryCount).toBe(0);
    },
  );
});

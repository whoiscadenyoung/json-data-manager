/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import {
  INLINE_GEOMETRY_BYTE_LIMIT,
  byteLength,
  geometryRowBudgetBytes,
} from "./geometry_storage.js";
import { GEOMETRY_PAGE_BYTE_BUDGET, paginateGeometriesBySchema } from "./internal/geometryPages.js";
import { initConvexTest } from "./setup.test.js";

/**
 * Issue #183: the geometry paginator sizes each `.take()` from the dataset's
 * stored worst-case row (`schemas.maxGeometryRowBytes`) instead of the global
 * ~900 KB inline limit. Under the old sizing a take held at most 5 rows, so a
 * 500-row page of points cost ~100 sequential reads and timed out on a real
 * backend ("too many system operations"); the tile worker's 500-row pages
 * never finished for datasets over ~350 small rows.
 */

type TestHarness = ReturnType<typeof initConvexTest>;

const BULK = 500; // rows per seeding mutation

async function createPointSchema(t: TestHarness): Promise<Id<"schemas">> {
  return t.mutation(api.schemas.createSchema, {
    geometryType: "Point",
    kind: "geospatial",
    schema: { title: "Points", type: "object" },
  });
}

function pointJson(i: number): string {
  return JSON.stringify({ coordinates: [i % 170, i % 80], type: "Point" });
}

async function seedPoints(t: TestHarness, schemaId: Id<"schemas">, count: number): Promise<void> {
  for (let start = 0; start < count; start += BULK) {
    // oxlint-disable-next-line no-await-in-loop -- seeding in bounded transactions; order is irrelevant but sequential keeps each one small.
    await t.mutation(api.entries.createEntriesBulk, {
      entries: Array.from({ length: Math.min(BULK, count - start) }, (_, k) => ({
        data: { n: start + k },
        geometry: pointJson(start + k),
      })),
      schemaId,
    });
  }
}

async function storedMaxRowBytes(t: TestHarness, schemaId: Id<"schemas">): Promise<number | null> {
  // `t.run` serializes `undefined` as null, so "absent" reads as null here.
  return t.run(async (ctx) => {
    const doc = await ctx.db.get(schemaId);
    return doc === null ? null : (doc.maxGeometryRowBytes ?? null);
  });
}

/** A Polygon whose JSON text is roughly `pointCount` × 20 bytes. */
function polygonJson(pointCount: number): string {
  const ring = Array.from({ length: pointCount }, (_, i) => [
    Number((Math.cos(i) * 10).toFixed(6)),
    Number((Math.sin(i) * 10).toFixed(6)),
  ]);
  ring.push(ring[0]);
  return JSON.stringify({ coordinates: [ring], type: "Polygon" });
}

/**
 * Runs the paginator directly with a `ctx.db` that counts `query()` calls —
 * one per `.take()` — so a test can pin how many sequential reads a page cost.
 */
async function paginateCountingTakes(
  t: TestHarness,
  schemaId: Id<"schemas">,
  numItems: number,
  maxGeometryRowBytes: number | undefined,
): Promise<{ isDone: boolean; rows: number; takes: number }> {
  return t.run(async (ctx) => {
    let takes = 0;
    const db = new Proxy(ctx.db, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return (table: "geometries") => {
              takes += 1;
              return target.query(table);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a counting wrapper over the real reader; only `db.query` is exercised.
      countingCtx = { ...ctx, db } as unknown as QueryCtx,
      result = await paginateGeometriesBySchema(
        countingCtx,
        schemaId,
        { cursor: null, numItems },
        maxGeometryRowBytes,
      );
    return { isDone: result.isDone, rows: result.page.length, takes };
  });
}

describe("maxGeometryRowBytes take sizing (issue #183)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("~2k tiny point rows return a full 500-row page in one call and one take", async () => {
    const t = initConvexTest(),
      schemaId = await createPointSchema(t);
    await seedPoints(t, schemaId, 2000);

    const stored = await storedMaxRowBytes(t, schemaId);
    expect(stored).toBe(
      Math.max(...Array.from({ length: 2000 }, (_, i) => byteLength(pointJson(i)))),
    );

    const page = await t.query(api.entries.listGeometries, {
      paginationOpts: { cursor: null, numItems: 500 },
      schemaId,
    });
    expect(page.page).toHaveLength(500);
    expect(page.isDone).toBe(false);

    const sized = await paginateCountingTakes(t, schemaId, 500, stored ?? undefined);
    expect(sized).toStrictEqual({ isDone: false, rows: 500, takes: 1 });

    // The pre-#183 fallback (unknown size) still works — just in five-row takes.
    const fallback = await paginateCountingTakes(t, schemaId, 500, undefined);
    expect(fallback.rows).toBe(500);
    expect(fallback.takes).toBe(100);
  });

  it("is born 0, grows monotonically on insert/replace, holds on delete, and resets on clear", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.schemas.createSchema, {
        geometryType: "Polygon",
        kind: "geospatial",
        schema: { title: "Polygons", type: "object" },
      }),
      small = polygonJson(10),
      big = polygonJson(2000);
    expect(await storedMaxRowBytes(t, schemaId)).toBe(0);

    const first = await t.mutation(api.entries.createEntry, {
      data: { n: 0 },
      geometry: small,
      schemaId,
    });
    expect(await storedMaxRowBytes(t, schemaId)).toBe(byteLength(small));

    // A replace that grows the row raises the bound…
    await t.mutation(api.entries.updateEntry, { data: { n: 0 }, entryId: first, geometry: big });
    expect(await storedMaxRowBytes(t, schemaId)).toBe(byteLength(big));
    // …and one that shrinks it, or a delete, never lowers it (an upper bound stays safe).
    await t.mutation(api.entries.updateEntry, { data: { n: 0 }, entryId: first, geometry: small });
    await t.mutation(api.entries.deleteEntry, { entryId: first });
    expect(await storedMaxRowBytes(t, schemaId)).toBe(byteLength(big));

    // An emptying clear knows the worst case again: nothing.
    await t.mutation(api.entries.createEntry, { data: { n: 1 }, geometry: big, schemaId });
    await t.mutation(api.entries.deleteEntriesBySchema, { schemaId });
    expect(await storedMaxRowBytes(t, schemaId)).toBe(0);
  });

  it("charges storage-backed rows the inline limit", () => {
    expect(geometryRowBudgetBytes({})).toBe(INLINE_GEOMETRY_BYTE_LIMIT);
    expect(geometryRowBudgetBytes({ geometryJson: "abc" })).toBe(3);
  });

  it("an unmeasured dataset stays unmeasured on write until the backfill stamps it", async () => {
    const t = initConvexTest(),
      schemaId = await createPointSchema(t);
    // Simulate a dataset that predates the field.
    await t.run(async (ctx) => {
      await ctx.db.patch(schemaId, { maxGeometryRowBytes: undefined });
    });
    await seedPoints(t, schemaId, 250);
    // A max over only the new rows could understate older ones, so writes leave it absent.
    expect(await storedMaxRowBytes(t, schemaId)).toBeNull();

    // Small catalogs measure synchronously-plus-scheduled-hops; drain them all.
    await t.mutation(api.entries.backfillGeometryRowBytes, {});
    await t.finishAllScheduledFunctions(() => {
      vi.runAllTimers();
    });
    expect(await storedMaxRowBytes(t, schemaId)).toBe(
      Math.max(...Array.from({ length: 250 }, (_, i) => byteLength(pointJson(i)))),
    );

    // Re-running is a no-op on measured datasets.
    expect(await t.mutation(api.entries.backfillGeometryRowBytes, {})).toStrictEqual({
      done: true,
      schemasPatched: 0,
    });
  });

  it("a stale (understated) bound still keeps pages within budget and loses nothing", async () => {
    const t = initConvexTest(),
      schemaId = await t.mutation(api.schemas.createSchema, {
        geometryType: "Polygon",
        kind: "geospatial",
        schema: { title: "Polygons", type: "object" },
      }),
      // ~400 KB rows: 15 of them are well over the 5 MB page budget.
      big = polygonJson(20_000),
      ROW_COUNT = 15;
    expect(ROW_COUNT * byteLength(big)).toBeGreaterThan(GEOMETRY_PAGE_BYTE_BUDGET);
    await t.mutation(api.entries.createEntriesBulk, {
      entries: Array.from({ length: ROW_COUNT }, (_, i) => ({ data: { n: i }, geometry: big })),
      schemaId,
    });
    // Pretend the stored bound is far too small (e.g. a write raced the backfill).
    await t.run(async (ctx) => {
      await ctx.db.patch(schemaId, { maxGeometryRowBytes: 1 });
    });

    const first = await t.query(api.entries.listGeometries, {
      paginationOpts: { cursor: null, numItems: 500 },
      schemaId,
    });
    expect(first.page.length * byteLength(big)).toBeLessThanOrEqual(GEOMETRY_PAGE_BYTE_BUDGET);
    expect(first.isDone).toBe(false);

    let seen = first.page.length,
      cursor = first.continueCursor,
      isDone = first.isDone;
    while (!isDone) {
      // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous cursor.
      const next = await t.query(api.entries.listGeometries, {
        paginationOpts: { cursor, numItems: 500 },
        schemaId,
      });
      seen += next.page.length;
      cursor = next.continueCursor;
      isDone = next.isDone;
    }
    expect(seen).toBe(ROW_COUNT);
  });
});

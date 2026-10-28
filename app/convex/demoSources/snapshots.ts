import { ConvexError, v } from "convex/values";

import { internal } from "../_generated/api";
import { action, internalMutation, internalQuery, query } from "../_generated/server";
import { auth } from "../auth";
import { getLocalSource } from "../sources";
import { SOURCE_KEY } from "./sources";

/**
 * The demo foreign app's snapshot side (docs/bound-datasets-design.md §6/
 * §8.3): it serializes its current state to a JSONL file and registers the
 * tag in `restaurantSnapshots`. Core tag ingest (../tags.ts) reads that
 * registry only through the source's `listSnapshots` adapter.
 */

const snapshotValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("restaurantSnapshots"),
  createdAt: v.number(),
  fileStorageId: v.id("_storage"),
  label: v.string(),
  ref: v.string(),
  rowCount: v.number(),
});

/** The shared projection join, callable from an action — one page per call. */
export const collectProjectionRowsQuery = internalQuery({
  // One page per call (sources.ts's #127 contract): the snapshot action
  // drains pages across transactions until the null cursor.
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await getLocalSource(SOURCE_KEY).listRows(ctx, args.cursor);
    // Snapshot files keep the {data, geometry} transport shape (no key) —
    // the file is the point-in-time state the import pipeline consumes.
    return {
      cursor: page.cursor,
      rows: page.rows.flatMap(({ data, geometry }) =>
        geometry === null || geometry === undefined
          ? []
          : [{ data, geometry: { coordinates: geometry.coordinates, type: geometry.type } }],
      ),
    };
  },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    rows: v.array(
      v.object({
        data: v.record(v.string(), v.any()),
        geometry: v.object({ coordinates: v.array(v.number()), type: v.string() }),
      }),
    ),
  }),
});

/** Inserts the tag row for a snapshot whose file the action already stored. */
export const registerSnapshot = internalMutation({
  args: {
    fileStorageId: v.id("_storage"),
    label: v.string(),
    rowCount: v.number(),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now(),
      // Opaque foreign snapshot id — unique per snapshot, stable forever,
      // and the only thing ingest needs to have seen before.
      ref = `snap_${createdAt.toString(36)}${Math.floor(Math.random() * 1296)
        .toString(36)
        .padStart(2, "0")}`;
    await ctx.db.insert("restaurantSnapshots", {
      createdAt,
      fileStorageId: args.fileStorageId,
      label: args.label,
      ref,
      rowCount: args.rowCount,
    });
    return { label: args.label, ref, rowCount: args.rowCount };
  },
  returns: v.object({ label: v.string(), ref: v.string(), rowCount: v.number() }),
});

/**
 * The foreign app takes a snapshot: serializes the current state to a JSONL
 * file and registers the tag. Stands in for the design's "push hook on
 * snapshot creation" — the dashboard's snapshots card drives it. Every call
 * is a NEW foreign snapshot (a fresh ref): idempotency belongs to ingest,
 * not to the foreign app's timeline. An action because file storage writes
 * (`ctx.storage.store`) live on the action writer.
 */
export const createRestaurantSnapshot = action({
  args: { label: v.string() },
  // Explicit return type: this handler references `internal.demoSources.snapshots.*`, whose
  // type resolves back through this module — inferring it would be circular.
  handler: async (ctx, args): Promise<{ label: string; ref: string; rowCount: number }> => {
    await auth(ctx);
    const label = args.label.trim();
    if (label === "") {
      throw new ConvexError("A snapshot label is required.");
    }
    // Explicit row type — the guidelines' workaround for the same-file
    // runQuery circularity (the query's type lands here via generated api).
    // The projection drains page by page across transactions until the null
    // cursor — a truncated snapshot must never register (#127 defect 1).
    const rows: Array<{
      data: Record<string, unknown>;
      geometry: { coordinates: number[]; type: string };
    }> = [];
    let cursor: string | null = null;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- paging the projection; the null cursor ends the drain.
      const page: { cursor: string | null; rows: typeof rows } = await ctx.runQuery(
        internal.demoSources.snapshots.collectProjectionRowsQuery,
        { cursor },
      );
      rows.push(...page.rows);
      if (page.cursor === null) {
        break;
      }
      cursor = page.cursor;
    }
    const jsonl = rows.map((row) => JSON.stringify(row)).join("\n"),
      fileStorageId = await ctx.storage.store(new Blob([jsonl], { type: "application/jsonl" }));
    return await ctx.runMutation(internal.demoSources.snapshots.registerSnapshot, {
      fileStorageId,
      label,
      rowCount: rows.length,
    });
  },
  returns: v.object({
    label: v.string(),
    ref: v.string(),
    rowCount: v.number(),
  }),
});

/** The foreign app's tag listing, newest first — the snapshots card's rows. */
export const listSnapshots = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    return ctx.db.query("restaurantSnapshots").order("desc").take(200);
  },
  returns: v.array(snapshotValidator),
});

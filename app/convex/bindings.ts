import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { auth } from "./auth";
import { SOURCE_KEY } from "./sources";

/**
 * The bound-datasets binding registry's read side and its escape hatch.
 * The sync engine lives in sync.ts (durable, keyed, resumable — #76) and
 * the source descriptors in sources.ts (#76's source interface); this file
 * keeps the queries the dataset page and dashboard subscribe to, plus the
 * explicit unbind flow (#75).
 */

const bindingValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("datasetBindings"),
  collectionId: v.optional(v.string()),
  keepVersions: v.optional(v.number()),
  lastAppliedCommitId: v.optional(v.string()),
  lastAppliedCommitSeq: v.optional(v.number()),
  lastReconciledAt: v.optional(v.number()),
  lastSyncedAt: v.optional(v.number()),
  pinnedRefs: v.optional(v.array(v.string())),
  schemaId: v.string(),
  schemaMapping: v.optional(v.any()),
  source: v.string(),
  sourceUpdatedAt: v.optional(v.number()),
  syncedEntryCount: v.optional(v.number()),
});

/** Every binding, with its dataset's title — the dashboard sync card's rows. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const bindings = await ctx.db.query("datasetBindings").take(100);
    return Promise.all(
      bindings.map(async (binding) => {
        const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
          schemaId: binding.schemaId,
        });
        return {
          _creationTime: binding._creationTime,
          _id: binding._id,
          lastReconciledAt: binding.lastReconciledAt,
          lastSyncedAt: binding.lastSyncedAt,
          source: binding.source,
          sourceUpdatedAt: binding.sourceUpdatedAt,
          syncedEntryCount: binding.syncedEntryCount,
          // A binding whose dataset vanished mid-unbind still lists — the
          // next sync recreates it — but with nothing to show.
          datasetExists: schema !== null,
          datasetTitle: schema !== null ? schema.title : binding.source,
        };
      }),
    );
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("datasetBindings"),
      lastReconciledAt: v.optional(v.number()),
      lastSyncedAt: v.optional(v.number()),
      source: v.string(),
      sourceUpdatedAt: v.optional(v.number()),
      syncedEntryCount: v.optional(v.number()),
      datasetExists: v.boolean(),
      datasetTitle: v.string(),
    }),
  ),
});

// Rows deleted per table per unbind-cleanup hop — the cleanup resumes until
// every related row is gone, so nothing is orphaned past one transaction's
// limits (#127 defect 10; the old cleanup stopped at .take(1000)).
const UNBIND_CLEANUP_BATCH = 100;

/**
 * The durable half of `unbind`: drains every row that references the binding
 * — the activity log, the projection's key map, the applied-commit mirrors,
 * the run history (with its chunk blobs) — UNBIND_CLEANUP_BATCH rows per
 * table per hop, rescheduling itself until all four are clean. Runs after
 * the binding row is already gone, keyed by the bindingId the rows carry.
 */
export const unbindCleanup = internalMutation({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) => {
    const [activity, mappings, mirrors, runs] = await Promise.all([
      ctx.db
        .query("datasetActivity")
        .withIndex("by_bindingId", (q) => q.eq("bindingId", args.bindingId))
        .take(UNBIND_CLEANUP_BATCH),
      ctx.db
        .query("bindingEntries")
        .withIndex("by_binding", (q) => q.eq("bindingId", args.bindingId))
        .take(UNBIND_CLEANUP_BATCH),
      ctx.db
        .query("commits")
        .withIndex("by_binding_seq", (q) => q.eq("bindingId", args.bindingId))
        .take(UNBIND_CLEANUP_BATCH),
      ctx.db
        .query("syncRuns")
        .withIndex("by_binding", (q) => q.eq("bindingId", args.bindingId))
        .take(UNBIND_CLEANUP_BATCH),
    ]);
    await Promise.all([
      ...activity.map(async (row) => {
        await ctx.db.delete(row._id);
      }),
      ...mappings.map(async (row) => {
        await ctx.db.delete(row._id);
      }),
      ...mirrors.map(async (row) => {
        await ctx.db.delete(row._id);
      }),
      ...runs.map(async (run) => {
        // The runs' collected chunk blobs are app storage — they go with the
        // rows that reference them (best-effort; the row delete stands).
        await Promise.all(
          run.chunkStorageIds.map(async (storageId) => {
            try {
              await ctx.storage.delete(storageId);
            } catch {
              // Best-effort cleanup.
            }
          }),
        );
        await ctx.db.delete(run._id);
      }),
    ]);
    const drainedAll = [activity, mappings, mirrors, runs].every(
      (batch) => batch.length < UNBIND_CLEANUP_BATCH,
    );
    if (!drainedAll) {
      await ctx.scheduler.runAfter(0, internal.bindings.unbindCleanup, {
        bindingId: args.bindingId,
      });
    }
  },
});

/**
 * Detaches a bound live dataset: deletes the projected dataset (allowed by
 * the component's read-only gate because this flow attests
 * `boundWrite: "unbind"`), removes the binding row, and schedules the
 * durable cleanup that drains every related row — activity history, the
 * projection's key map, the commit mirrors, and the run history with its
 * chunk blobs. The source tables are untouched — a later sync simply
 * re-creates the projection. Deleting a bound dataset any other way stays
 * blocked. (The UI confirms before calling this.)
 */
export const unbind = mutation({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .first();
    if (binding === null) {
      throw new ConvexError("This dataset has no source binding to remove.");
    }
    await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
      boundWrite: "unbind",
      schemaId: binding.schemaId,
    });
    // The binding row goes now (the dataset is already gone); everything
    // that references it drains through the rescheduled cleanup.
    await ctx.db.delete(binding._id);
    await ctx.scheduler.runAfter(0, internal.bindings.unbindCleanup, {
      bindingId: binding._id,
    });
  },
});

/**
 * Binding + projected dataset status for the primary demo source — CLI
 * checks and the dashboard's badge. `null` before the first sync.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", SOURCE_KEY))
      .first();
    if (!binding) {
      return null;
    }
    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: binding.schemaId,
    });
    return { binding, schema };
  },
  returns: v.union(
    v.null(),
    v.object({
      binding: bindingValidator,
      schema: v.any(),
    }),
  ),
});

/**
 * The binding for one projected dataset (by the json-cms schema id) — how
 * the dataset page learns its sync state (lastSyncedAt vs sourceUpdatedAt).
 * `null` for ordinary, non-bound datasets.
 */
export const getBySchema = query({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    return ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .first();
  },
  returns: v.union(v.null(), bindingValidator),
});

const activityValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("datasetActivity"),
  added: v.number(),
  bindingId: v.id("datasetBindings"),
  entryCount: v.number(),
  kind: v.optional(v.union(v.literal("sync"), v.literal("reconcile"))),
  // Set when the run scheduled a reconcile to repair a key its commit tail
  // could not apply (#127 defect 6).
  needsReconcile: v.optional(v.boolean()),
  ops: v.array(
    v.object({
      detail: v.optional(v.string()),
      label: v.string(),
      op: v.union(v.literal("add"), v.literal("remove"), v.literal("update")),
    }),
  ),
  removed: v.number(),
  schemaId: v.string(),
  syncedAt: v.number(),
  truncated: v.optional(v.boolean()),
  updated: v.number(),
});

/**
 * The sync/reconcile activity log for one bound dataset, newest first —
 * the History tab's data. Bounded to the 50 most recent entries; per-run
 * granularity until the design's commit-level feed lands (phase 4, #77).
 */
export const history = query({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) => {
    await auth(ctx);
    return ctx.db
      .query("datasetActivity")
      .withIndex("by_bindingId", (q) => q.eq("bindingId", args.bindingId))
      .order("desc")
      .take(50);
  },
  returns: v.array(activityValidator),
});

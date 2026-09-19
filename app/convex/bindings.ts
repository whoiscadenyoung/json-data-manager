import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
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
          datasetTitle:
            schema !== null ? schema.title : binding.source,
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

/**
 * Detaches a bound live dataset: deletes the projected dataset (allowed by
 * the component's read-only gate because this flow attests
 * `boundWrite: "unbind"`), then removes the binding row, its activity
 * history, and the projection's key map. The source tables are untouched —
 * a later sync simply re-creates the projection. Deleting a bound dataset
 * any other way stays blocked.
 */
export const unbind = mutation({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
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
    // The activity log describes the projection it synced, and the key map
    // points into it — both go with it.
    const [activity, mappings] = await Promise.all([
      ctx.db
        .query("datasetActivity")
        .withIndex("by_bindingId", (q) => q.eq("bindingId", binding._id))
        .take(1000),
      ctx.db
        .query("bindingEntries")
        .withIndex("by_binding", (q) => q.eq("bindingId", binding._id))
        .take(1000),
    ]);
    await Promise.all([
      ...activity.map(async (row) => {
        await ctx.db.delete(row._id);
      }),
      ...mappings.map(async (row) => {
        await ctx.db.delete(row._id);
      }),
      ctx.db.delete(binding._id),
    ]);
  },
});

/**
 * Binding + projected dataset status for the primary demo source — CLI
 * checks and the dashboard's badge. `null` before the first sync.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
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
  handler: async (ctx, args) =>
    ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .first(),
  returns: v.union(v.null(), bindingValidator),
});

const activityValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("datasetActivity"),
  added: v.number(),
  bindingId: v.id("datasetBindings"),
  entryCount: v.number(),
  kind: v.optional(v.union(v.literal("sync"), v.literal("reconcile"))),
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
  handler: async (ctx, args) =>
    ctx.db
      .query("datasetActivity")
      .withIndex("by_bindingId", (q) => q.eq("bindingId", args.bindingId))
      .order("desc")
      .take(50),
  returns: v.array(activityValidator),
});

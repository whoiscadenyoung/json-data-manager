import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Host tables for CMS-side dataset tables (the activity feed shown on dataset pages).
 * Spread into `convex/schema.ts` with one line (ADR 0014).
 */
export const cmsTables = {
  // One row per sync of a bound dataset — the activity log the dataset
  // page's History tab renders (per-sync granularity for now; the design's
  // commit-level feed upgrades this later). `ops` summarizes what changed,
  // keyed by the projection's natural key (location label); it is capped at
  // 200 entries with `truncated` set on overflow so a doc can never
  // approach the 1 MiB limit. Rows survive dataset re-creation during
  // migration because they point at the binding, not the schema.
  datasetActivity: defineTable({
    added: v.number(),
    bindingId: v.id("datasetBindings"),
    entryCount: v.number(),
    // "sync" (the regular pull, also the pre-field default) or "reconcile"
    // (the periodic/manual full diff-and-repair pass).
    kind: v.optional(v.union(v.literal("sync"), v.literal("reconcile"))),
    // Set when the run hit a commit op it could not apply (an `update` whose
    // foreign key had no projection mapping) and scheduled a reconcile to
    // repair it — #127 defect 6.
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
  }).index("by_bindingId", ["bindingId"]),
};

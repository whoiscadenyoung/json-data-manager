import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Host tables for bound-datasets sync state: bindings, the entry key map, sync runs, remote-source checks and the applied-commit mirror (docs/bound-datasets-design.md).
 * Spread into `convex/schema.ts` with one line (ADR 0014).
 */
export const sourceTables = {
  // The projection's key map (docs/bound-datasets-design.md §4): one row per
  // projected foreign row, `entryKey` → the json-cms entry holding it (a
  // component id as a plain string — component tables don't exist in this
  // deployment's generated data model). This is what makes the durable sync
  // idempotent (an interrupted run re-applies by key without duplicating)
  // and delete detection possible (keys the completing run didn't see are
  // gone from the source). `seenRun` names the last run that saw the key.
  bindingEntries: defineTable({
    bindingId: v.id("datasetBindings"),
    entryId: v.string(),
    entryKey: v.string(),
    seenRun: v.optional(v.string()),
  }).index("by_binding", ["bindingId", "entryKey"]),

  // The binding registry — one row per json-cms dataset projected from a
  // source in this schema. `source` is a stable key for the source table
  // (today only "restaurantLocations"); `schemaId`/`collectionId` hold the
  // json-cms ids as plain strings, since component tables don't exist in
  // this deployment's generated data model. Sync state rides along so a
  // UI "synced N minutes ago" badge needs no extra queries.
  datasetBindings: defineTable({
    collectionId: v.optional(v.string()),
    // The foreign commit cursor: the last commit the sync engine applied
    // (its stable foreignCommitId and per-source monotonic seq). Commit-tail
    // sync pages the source's feed since this; a full sync/reconcile
    // re-baselines it to the source's newest seq.
    lastAppliedCommitId: v.optional(v.string()),
    lastAppliedCommitSeq: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    // Set when the last full reconcile (the drift-repair pass) finished.
    lastReconciledAt: v.optional(v.number()),
    // Version retention (docs/bound-datasets-design.md §7): keep the newest
    // N unpinned frozen versions (default DEFAULT_KEEP_VERSIONS); pinned
    // refs are exempt and never auto-retire.
    keepVersions: v.optional(v.number()),
    pinnedRefs: v.optional(v.array(v.string())),
    // The source's declared projection mapping (see sources.ts), snapshotted
    // at bind time so the binding is self-describing.
    schemaMapping: v.optional(v.any()),
    schemaId: v.string(),
    source: v.string(),
    // Set by the dashboard's source-table mutations on every write, so the
    // UI can show "source changed since last sync" without diffing rows —
    // the PoC stand-in for the design's commit cursor.
    // Remote sources (#78) also stamp it from `remoteSources` checks whenever
    // the remote layer's revision has moved past `remoteRevision`, so the
    // same staleness badges cover both transports.
    sourceUpdatedAt: v.optional(v.number()),
    syncedEntryCount: v.optional(v.number()),
    // Remote sources only: the layer revision the last completed sync read
    // (its first page's), and the manifest schemaVersion the dataset was
    // built from — a later mismatch blocks Sync as "schema changed".
    remoteRevision: v.optional(v.number()),
    remoteSchemaVersion: v.optional(v.string()),
  })
    .index("by_source", ["source"])
    .index("by_schema", ["schemaId"]),

  // The latest manifest check per remote source (#78,
  // docs/remote-source-adapter-design.md §5) — kept apart from the binding
  // so a never-synced source can show its layer, and so the cron's frequent
  // writes don't contend with the binding the sync engine stamps.
  remoteSourceChecks: defineTable({
    checkedAt: v.number(),
    // Set when the last check failed; the layer fields then keep the last
    // successful read.
    error: v.optional(v.string()),
    layer: v.optional(
      v.object({
        description: v.optional(v.string()),
        featureCount: v.optional(v.number()),
        geometryType: v.string(),
        revision: v.number(),
        schema: v.any(),
        schemaVersion: v.string(),
        title: v.string(),
      }),
    ),
    recordUrlTemplate: v.optional(v.string()),
    source: v.string(),
  }).index("by_source", ["source"]),

  // One durable sync run (docs/bound-datasets-design.md §5): the run's
  // source rows are chunked into app-storage blobs during "collecting", then
  // applied keyed and idempotently during "applying" — checkpointed at
  // `chunkIndex`/`rowOffset` and progressed at `lastProgressAt`, so an
  // interrupted run resumes exactly where it stopped without duplicating or
  // losing rows. `ops` is the activity summary, capped at 200 like
  // `datasetActivity.ops`. The engine lives in sync.ts.
  syncRuns: defineTable({
    added: v.number(),
    applied: v.number(),
    bindingId: v.id("datasetBindings"),
    chunkIndex: v.number(),
    chunkStorageIds: v.array(v.id("_storage")),
    error: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
    lastProgressAt: v.number(),
    // "sync" prefers the source's commit tail (the design's primary path);
    // it falls back to a full pass when the source has no commit feed or the
    // binding has no baseline yet. "reconcile" always diffs full state.
    // "sweeping" is finalize's batched delete phase for full modes (#127
    // defect 9) — the scheduler drives it, one bounded batch per hop.
    mode: v.union(v.literal("commit-tail"), v.literal("reconcile"), v.literal("sync")),
    // The newest source seq observed at collect time — the baseline a full
    // run stamps onto the binding, or the tail's last seq a tail run applies.
    // `lastCommitId` is that commit's stable foreignCommitId (the cursor).
    lastCommitId: v.optional(v.string()),
    lastSeq: v.optional(v.number()),
    // How many times this run's collect has been scheduled (initial + revives).
    // A run past MAX_COLLECT_ATTEMPTS is failed instead of revived again —
    // a poison collect must not be rescheduled forever (#127 defect 3).
    collectAttempts: v.optional(v.number()),
    // The current worker's lease token (#127 defect 7): minted at every
    // schedule/revive, checked by markCollected and every apply/finalize
    // mutation, so a superseded action can neither double-apply nor finalize.
    claim: v.optional(v.string()),
    // Set when a commit op could not be applied from the tail alone (an
    // `update` whose foreign key had no projection mapping); completion
    // schedules a full reconcile to repair it (#127 defect 6).
    needsReconcile: v.optional(v.boolean()),
    ops: v.array(
      v.object({
        detail: v.optional(v.string()),
        label: v.string(),
        op: v.union(v.literal("add"), v.literal("remove"), v.literal("update")),
      }),
    ),
    // Remote sources: the layer revision of the run's FIRST rows page —
    // what completion stamps as the binding's `remoteRevision`, so a write
    // landing mid-drain reads as out of date again rather than being lost.
    remoteRevision: v.optional(v.number()),
    removed: v.number(),
    rowOffset: v.number(),
    source: v.string(),
    startedAt: v.number(),
    status: v.union(
      v.literal("collecting"),
      v.literal("applying"),
      v.literal("sweeping"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    total: v.number(),
    truncated: v.boolean(),
    updated: v.number(),
  }).index("by_binding", ["bindingId"]),

  // The json-cms mirror of the applied commit tail (docs/bound-datasets-design.md
  // §4): one row per foreign commit the sync engine applied to a binding,
  // kept host-side so the History rail and commit overlays survive the
  // foreign app pruning its own log. `ops` is capped by pruning (only the
  // newest COMMIT_MIRROR_LIMIT rows per binding are kept), not per row.
  commits: defineTable({
    appliedAt: v.number(),
    at: v.number(),
    bindingId: v.id("datasetBindings"),
    foreignCommitId: v.string(),
    message: v.string(),
    ops: v.array(
      v.object({
        // The projected row's foreign key.
        entryKey: v.string(),
        fields: v.array(
          v.object({
            after: v.optional(v.any()),
            before: v.optional(v.any()),
            name: v.string(),
          }),
        ),
        geometryChanged: v.boolean(),
        op: v.union(v.literal("add"), v.literal("delete"), v.literal("update")),
      }),
    ),
    seq: v.number(),
  }).index("by_binding_seq", ["bindingId", "seq"]),
};

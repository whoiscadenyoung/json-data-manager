import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// App-specific tables coexist with the @caden/json-cms component's own
// tables (which stay namespaced inside the component — nothing here touches
// them). These three model a stand-in for the "foreign" app's preexisting
// domain from the bound-datasets integration design
// (docs/bound-datasets-design.md): a non-geospatial parent table, a lat/lng
// location table, and a many-to-many join — the shape real foreign data is
// expected to take. `datasetBindings` is the first cut of the design's
// binding registry: it points a json-cms dataset at one of these sources.
export default defineSchema({
  // The app-side user profile, one row per Better Auth user. `authId` is the
  // Better Auth user id (the `user._id` inside the @convex-dev/better-auth
  // component — Better Auth's user/session/account tables stay namespaced in
  // the component and never appear in this schema). Rows are maintained
  // exclusively by the component's user triggers in auth.ts; don't insert or
  // delete them anywhere else. Email/name mirror the auth record so UI can
  // render the signed-in user from one query.
  users: defineTable({
    authId: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    name: v.optional(v.string()),
  })
    .index("by_authId", ["authId"])
    .index("by_email", ["email"]),

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
    sourceUpdatedAt: v.optional(v.number()),
    syncedEntryCount: v.optional(v.number()),
  })
    .index("by_source", ["source"])
    .index("by_schema", ["schemaId"]),

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
    mode: v.union(v.literal("commit-tail"), v.literal("reconcile"), v.literal("sync")),
    // The newest source seq observed at collect time — the baseline a full
    // run stamps onto the binding, or the tail's last seq a tail run applies.
    // `lastCommitId` is that commit's stable foreignCommitId (the cursor).
    lastCommitId: v.optional(v.string()),
    lastSeq: v.optional(v.number()),
    ops: v.array(
      v.object({
        detail: v.optional(v.string()),
        label: v.string(),
        op: v.union(v.literal("add"), v.literal("remove"), v.literal("update")),
      }),
    ),
    removed: v.number(),
    rowOffset: v.number(),
    source: v.string(),
    startedAt: v.number(),
    status: v.union(
      v.literal("collecting"),
      v.literal("applying"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    total: v.number(),
    truncated: v.boolean(),
    updated: v.number(),
  }).index("by_binding", ["bindingId"]),

  locations: defineTable({
    address: v.string(),
    city: v.string(),
    label: v.string(),
    lat: v.number(),
    lng: v.number(),
    state: v.string(),
  }).index("by_label", ["label"]),

  // Many-to-many: a restaurant operates many locations, and a location can
  // have hosted more than one restaurant over time (replacements, food
  // courts) — so the relationship gets its own table rather than a
  // location -> restaurant pointer.
  restaurantLocations: defineTable({
    locationId: v.id("locations"),
    openedYear: v.optional(v.number()),
    restaurantId: v.id("restaurants"),
  })
    .index("by_locationId", ["locationId"])
    .index("by_restaurantId_and_locationId", ["restaurantId", "locationId"]),

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

  // The delta between two consecutive frozen versions, computed at ingest
  // into the commits' ops shape (docs/bound-datasets-design.md §6) — the
  // historical record of "what changed between tag N-1 and tag N". The
  // compare view computes arbitrary pairs on demand instead (see
  // tags.getVersionDelta), so only sequential pairs are stored.
  tagDeltas: defineTable({
    at: v.number(),
    fromRef: v.optional(v.string()),
    ops: v.array(
      v.object({
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
    sourceSchemaId: v.string(),
    toRef: v.optional(v.string()),
  }).index("by_source", ["sourceSchemaId"]),

  // The foreign app's own commit log — the stand-in for its git-like
  // versioning (commits are small field-level deltas). The dashboard's
  // source-table writes append one row per user action; the sync engine's
  // primary path pages this feed since the binding's last-applied commit.
  // `seq` is monotonic per source and `foreignCommitId` is stable forever —
  // together they make the feed idempotent to re-read.
  sourceCommits: defineTable({
    at: v.number(),
    foreignCommitId: v.string(),
    message: v.string(),
    ops: v.array(
      v.object({
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
    source: v.string(),
  }).index("by_source_seq", ["source", "seq"]),

  restaurants: defineTable({
    cuisine: v.string(),
    name: v.string(),
  }).index("by_name", ["name"]),

  // The foreign app's tag registry — the PoC stand-in for its snapshot
  // mechanism (docs/bound-datasets-design.md §6/§8.3): one row per snapshot
  // the foreign app has taken of the restaurants domain. `ref` is the
  // foreign app's opaque snapshot id (unique; the ingest's idempotency
  // key), and `fileStorageId` points at the snapshot file — JSONL of
  // {data, geometry} projection rows, the transport shape the design
  // specifies. json-cms never writes here: tags.ts reads the listing and
  // ingests missing snapshots into frozen version datasets.
  restaurantSnapshots: defineTable({
    createdAt: v.number(),
    fileStorageId: v.id("_storage"),
    label: v.string(),
    ref: v.string(),
    rowCount: v.number(),
  }).index("by_ref", ["ref"]),
});

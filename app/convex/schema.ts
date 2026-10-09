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

  // One materialized-publish attempt (roadmap 5b, #100; lifecycle doc §6):
  // the syncRuns-pattern durability row for the window the sync engine never
  // had — chunk production is CLIENT-side (roadmap §2), so the attempt
  // persists each uploaded chunk's storage id as it lands, letting a resumed
  // browser re-execute the spec and upload only the missing chunks. One
  // attempt per publish click; `publishKey` is its idempotency key, re-checked
  // INSIDE the freeze transaction (the by-ref lookup — a retried/killed
  // publish cannot fork two v1s; uniqueness is enforced there, not by an
  // index — Convex has none). After the freeze hands off to the component's
  // import workflow (`importId`), durability is already the workflow's: the
  // attempt only mirrors its outcome (pollImport). Two layers, one handoff —
  // deliberately never merged (issue scope note).
  //
  // The frozen row's creation inputs ride the attempt so the freeze is
  // host-side and atomic: for a derived publish the client reports the
  // executed output's schema/kind/geometryType plus the spec it actually ran
  // (`planned*`/`spec`); a draft publish resolves all of it from the draft at
  // freeze time. `publishedSchemaId` + `publishKey` per completed attempt are
  // the host-side version chain for derived datasets (whose component lineage
  // anchors on `sourceKey`, not a component row) — the seam stage 6 builds
  // on, laid down and nothing more.
  publishAttempts: defineTable({
    // Component-storage ids, PLAIN STRINGS: the blobs live in the COMPONENT's
    // namespaced storage (the client uploads through the component's upload
    // URL), so a host `_storage` id validator would vouch for the wrong table
    // — the same boundary rule `importId`/`publishedSchemaId` below follow,
    // and `versioning.freezeVersion`'s own `chunkStorageIds` argument.
    chunkStorageIds: v.array(v.string()),
    // Attribution (ADR 0007), like every host-written row — and, since stage
    // 8 (#104), the OWNERSHIP key: every attempt read and client-driven step
    // (plan/chunks/freeze) answers only to its creator.
    createdBy: v.string(),
    // The dataset being published: a component dataset id (a lifecycle
    // "draft" import) or a derivedDatasets registry row id — plain strings,
    // the datasetBindings precedent (which table answers is `datasetKind`).
    datasetKey: v.string(),
    datasetKind: v.union(v.literal("draft"), v.literal("derived")),
    error: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
    importId: v.optional(v.string()),
    lastProgressAt: v.number(),
    plannedChunkCount: v.optional(v.number()),
    // The executed content's fingerprint (issue #130), as the client's plan
    // reported it: a resuming browser re-fingerprints its own execution and
    // resets the upload whenever the two differ — counts alone cannot see an
    // edit that preserves the chunk count. A plain string, not a Convex
    // hash type: the fingerprint scheme is the client's (see
    // src/lib/publish.ts fingerprintChunks).
    plannedContentHash: v.optional(v.string()),
    plannedGeometryType: v.optional(v.string()),
    plannedKind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    plannedSchema: v.optional(v.any()),
    plannedTotalRows: v.optional(v.number()),
    publishKey: v.string(),
    publishedSchemaId: v.optional(v.string()),
    // The row total the attempt's registered chunks declared (issue #130) —
    // registerChunk accumulates each chunk's rowCount here, and the freeze
    // refuses an attempt whose registered total doesn't match
    // plannedTotalRows. Absent on attempts that predate the field.
    registeredRowCount: v.optional(v.number()),
    // The spec the client executed (derived publishes only) — kept so the
    // frozen row's `lineage.recipe` records the rows that actually landed,
    // not whatever the registry row holds at freeze time.
    spec: v.optional(v.any()),
    startedAt: v.number(),
    status: v.union(
      v.literal("uploading"),
      v.literal("importing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    title: v.string(),
    versionLabel: v.string(),
  })
    // Uniqueness of publishKey is NOT an index: Convex has none, and the
    // enforcement point is the freeze transaction's global by-ref re-check
    // (the component's by_lineage_snapshotRef lookup).
    .index("by_dataset", ["datasetKey"]),

  // The derived-dataset registry (roadmap stage 2, #95; ADR 0005 §10.2): one
  // row per transform spec producing a virtual derived dataset. Catalog-level,
  // never map-level (ADR 0005): the row's own _id is the derived dataset's
  // stable id, and nothing nests under a map, layer, or (future) project.
  // Deliberately virtual — no entries/geometries rows, no boundingBox, none
  // of the published-layer machinery; every consumer computes rows client-side
  // through the row-resolution seam (docs/derived-datasets-design.md §5).
  // Convex is uninvolved in computation: this table stores specs.
  derivedDatasets: defineTable({
    // Attribution (ADR 0007): the Better Auth user id — the same string
    // schemas.createdBy holds (the auth() hook's identity.subject).
    createdBy: v.string(),
    // The persisted dependency edges, denormalized from the spec at save
    // time: [sourceDatasetId, ...each operation's dataset], distinct,
    // first-seen order. The spec itself still carries everything (the
    // component's spec.ts:16-19) — these edges are what the save-time
    // cycle walk follows (findCycleToOrigin reads them, not the stored
    // spec), and they are the material stage 3's reverse "what reads this
    // dataset" lookups will index.
    dependsOn: v.array(v.string()),
    description: v.optional(v.string()),
    // A component dataset id (or another registry row's id, for
    // derived-of-derived) stored as a plain string — the datasetBindings
    // precedent: component tables don't exist in this deployment's generated
    // data model.
    sourceDatasetId: v.string(),
    // The serializable TransformSpec
    // (packages/json-cms/src/shared/transform/spec.ts), stored shapeless like
    // datasetBindings' schemaMapping above: a per-operation validator would
    // reject stage 4's new operation kinds and force a stored-spec migration
    // the shape rules forbid (spec.ts:13-15). Structural sanity is checked in
    // the save mutation instead — narrowly enough to stay additive.
    spec: v.any(),
    // "draft" (builder autosave, still being authored) vs "saved" (explicitly
    // saved). Stage 5's publish lifecycle extends this additively with new
    // literals — which is why it is an open union, not a virtual-only
    // boolean that lineage/publish fields can't grow past.
    status: v.union(v.literal("draft"), v.literal("saved")),
    // The derived dataset's display name — the only required field (the
    // UI-polish rule: title required, description optional, everywhere).
    title: v.string(),
  })
    .index("by_source", ["sourceDatasetId"])
    // Status leads so the catalog projection can scan saved rows directly
    // (drafts are invisible to catalog consumers — lifecycle doc §3); the
    // trailing sourceDatasetId keeps every index field in the name.
    .index("by_status_and_source", ["status", "sourceDatasetId"])
    // The Transform tab's index-served leg (issue #128): source first,
    // creator second, so a viewer's own rows for one source read without
    // scanning anyone else's drafts — the old by_source read filtered
    // visibility AFTER take(200), letting other users' drafts push visible
    // rows out of the window.
    .index("by_source_and_creator", ["sourceDatasetId", "createdBy"]),

  // One version reference a consuming artifact holds on another dataset's
  // version chain (roadmap stage 6, #101; lifecycle doc §2/§7): pin (a
  // specific frozen version) or float (the chain's head). The issue's
  // recorded decision — stage-2 registry source references gain the pin/float
  // mode app-side — generalized into a FIRST-CLASS host table so stage 7's
  // fork-as-reference mints rows here too, never a component-table overload
  // and never a registry-field overload (a derived spec's `dependsOn` can
  // name several sources; each edge carries its own mode).
  //
  // Today's writers: the registry save path (one float row per saved spec
  // dependency — live compute-on-read IS float semantics), the sync/revert/pin
  // mutations in consumption.ts, and since 7b (#103) the bundle press's map
  // leg (one float row per direct dataset layer target, the layer reads' chain
  // resolution) plus projects.addArtifact's fork leg (one float row per
  // dataset membership, consumerId = the membership row). Collections still
  // hold no version reference — their bundle role is behavioral and their
  // membership live.
  consumerReferences: defineTable({
    // The consuming artifact's stable host id (a derivedDatasets registry row
    // id today) — plain string: consumers may be component ids in later
    // stages, and the host-boundary id rule keeps one shape.
    consumerId: v.string(),
    // Open union (the lifecycle-field precedent): stage 6 shipped "derived";
    // stage 7b (#103) added "map" (retired with standalone maps in phase 3 of
    // the project-workspace design — maps are project-owned rows now and hold
    // no dataset edges) and "fork" (fork-as-reference: one float row per
    // project membership on a dataset — consumerId is the projectArtifacts
    // row id, so removing the membership removes the edge with it). Modes
    // mean the same thing for every kind: float = at head, pin = the
    // pinnedRef row. A LINKED LAYER member deliberately carries NO edge here:
    // its pin IS its membership's artifactId (the pinned layerVersions row —
    // see the layers table), so there is nothing for a "layer" kind to add.
    consumerKind: v.union(v.literal("derived"), v.literal("fork")),
    mode: v.union(v.literal("float"), v.literal("pin")),
    // When pinned: the durable version identity — the frozen row's global
    // `lineage.snapshotRef` ("a ref never freezes twice", versioning.ts) with
    // that row's component id as the render target. Both absent on float.
    pinnedRef: v.optional(v.string()),
    pinnedSchemaId: v.optional(v.string()),
    // The referenced dataset, exactly as the consumer's spec names it — a
    // component dataset id, a frozen version row id, or a registry row id.
    // Plain string (the datasetBindings precedent); chain resolution asks
    // each table in turn at read time.
    sourceDatasetId: v.string(),
  })
    .index("by_consumer", ["consumerId"])
    .index("by_source", ["sourceDatasetId"])
    // The retire gate (#126): which references still pin one frozen row —
    // tags.retireVersion refuses while any row answers, so a manual retire
    // can never leave a pinned consumer dangling. Every pin path
    // (setReferenceMode/sync/revert) writes pinnedSchemaId alongside
    // pinnedRef, so the id is the complete pin identity.
    .index("by_pinnedSchemaId", ["pinnedSchemaId"]),

  // The publish-side retention policy store (roadmap stage 6, #101): keep-N
  // and pinned refs for PUBLISH chains — the derived-side store tags.ts said
  // stage 6 must build ("no binding policy store to pin them under until
  // stage 6 builds the derived-side policy store"). Keyed by the chain
  // anchor: the draft's component id (a draft-published chain, the
  // `lineage.sourceSchemaId` anchor) or the registry row id (a
  // derived-published chain, the `lineage.sourceKey` anchor) — plain strings
  // either way, the datasetBindings precedent. One row per anchor, created on
  // first policy write; ABSENCE reads as the defaults (keep
  // DEFAULT_KEEP_VERSIONS, nothing pinned), so no backfill is ever required.
  // Bound live datasets keep their policy in `datasetBindings` (the tag
  // path's store) — consumption.ts resolves both stores behind one read.
  versionPolicies: defineTable({
    datasetKey: v.string(),
    keepVersions: v.optional(v.number()),
    pinnedRefs: v.optional(v.array(v.string())),
  }).index("by_dataset", ["datasetKey"]),

  // Projects (roadmap stage 7a, #102; lifecycle doc §3-§4, ADR 0008): one row
  // per working container — the virtual working layer where imports,
  // transform specs, and map arrangements are drafted before publish crosses
  // them into the materialized catalog. Deliberately APP-SIDE: the component
  // never learns projects exist (nothing published knows projects exist —
  // lifecycle §4), so a project holds artifacts through `projectArtifacts`
  // membership rows naming plain-string component/registry ids — references,
  // never copies and never containment ("fork = add-to-project", §3).
  //
  // NO lifecycle field on purpose: a project is always draft-side. Publish is
  // per-artifact (7b's bundle publish walks the membership rows through the
  // existing 5b state machine), never a project state flip (lifecycle §3's
  // state model runs over datasets, not containers).
  //
  // `createdBy` is attribution (ADR 0007) and the guaranteed-owner anchor
  // (the creator's `projectMembers` row is born with the project and its role
  // can never be changed or removed — at least one owner always exists).
  // Since phase 1 of the project-workspace design (ADR 0011) ownership is
  // carried by the `projectMembers` rows, not by this stamp alone: every
  // write goes through projects.projectForWrite's ROLE check, and every read
  // is member-scoped — `projects.list` returns projects the caller belongs to
  // (the by_user index on projectMembers) and `projects.get` answers null to
  // non-members — which is what keeps the issue's "other users' and anonymous
  // views never show the drafts" true for everything this stage introduces.
  // Anonymous callers never get this far (rejected at the auth choke point,
  // auth.ts).
  projects: defineTable({
    // The auth() hook's identity.subject — the Better Auth user id, the same
    // string schemas.createdBy holds.
    createdBy: v.string(),
    description: v.optional(v.string()),
    // Denormalized membership total so browser cards show a count without a
    // per-project membership scan (guidelines: no `.collect().length`
    // counts). Kept in lockstep by projects.ts's membership writes — every
    // insert/delete of a membership row patches this in the SAME transaction,
    // so the two can never drift.
    artifactCount: v.number(),
    // The only required field (the UI rule: title required, description
    // optional, everywhere).
    title: v.string(),
  }).index("by_createdBy", ["createdBy"]),

  // One project ↔ artifact membership row (roadmap 7a, #102) — the recorded
  // answer to the issue's open "references vs membership rows" item: membership
  // rows, because a component dataset cannot carry a projectId (the component
  // stays project-blind, lifecycle §4) so the reference must live app-side.
  // The membership row and a draft dataset created into the project are born
  // in ONE transaction (projects.createDraftDataset), so a crash can never
  // orphan either. NEVER an array field on the project doc instead: membership
  // grows unbounded and every add would rewrite the project (guidelines).
  //
  // Phase 2 of the project-workspace design adds the member-role pair — the
  // "link XOR modify" line of the model table:
  // - `role: "owned" | "linked"` — OWNED: the workspace's own working copy
  //   (a draft created in the project, or any draft pulled in by reference —
  //   ADR 0011 makes project-held drafts member-editable, which IS the
  //   "modify" side). LINKED: a versioned row the project references but
  //   didn't create — a published dataset, a saved derived row, a map. The
  //   project's view of a linked member is PINNED (the version-reference edge
  //   below); "read-only" is the pin, not a write restriction on the
  //   underlying row (ADR 0009's co-editable clause stands for it).
  // - `syncMode: "manual" | "auto"` — the per-member "keep in sync" checkbox
  //   (design model rules): "manual" (the default) keeps a LINKED member
  //   pinned — updates are the explicit Sync action; "auto" floats it live on
  //   the source's chain head. Meaningless on owned members (they have no
  //   version relationship; the sync surface refuses them) and stamped
  //   uniformly anyway so every row carries the same shape.
  //
  // Both fields are OPTIONAL on purpose (ADR 0010's additive-field stance):
  // absent reads as the phase-1 behavior — rows minted before this phase
  // floated their version edges, so absent `syncMode` reads as "auto", and
  // absent `role` derives from what the row is (draft → "owned", else
  // "linked"). projects.ts's artifactRoleOf/syncModeOf are the one derivation;
  // every INSERT path stamps both fields explicitly.
  projectArtifacts: defineTable({
    // Attribution, same stance as projects.createdBy (ownership rides the
    // membership's project's creator check — stage 8).
    addedBy: v.string(),
    // The referenced artifact — ONE plain-string id space across kinds:
    // artifactKind says which table answers (a component dataset id, a
    // derivedDatasets registry row id, or — from phase 3 of the
    // project-workspace design — an app-side id: an owned layer's `layers`
    // row id, or a LINKED layer's pinned `layerVersions` row id, which IS
    // the pin). Component tables don't exist in this deployment's generated
    // data model, so no v.id() of them is possible here (the
    // datasetBindings precedent). NEVER overloaded onto a spec's dependsOn
    // or any component field.
    artifactId: v.string(),
    // Open literal union on purpose (the derivedDatasets.status /
    // consumerReferences.consumerKind precedent). Phase 2 of the
    // project-workspace design added "layer"; phase 3 introduces the layers
    // entity and RETIRES "map" with the standalone maps — a map is a
    // projectMaps row now, never a membership.
    artifactKind: v.union(v.literal("dataset"), v.literal("derived"), v.literal("layer")),
    projectId: v.id("projects"),
    role: v.optional(v.union(v.literal("owned"), v.literal("linked"))),
    syncMode: v.optional(v.union(v.literal("manual"), v.literal("auto"))),
  })
    // The workspace read: everything in one project.
    .index("by_project", ["projectId"])
    // The reverse lookup ("which projects hold this artifact") and cleanup.
    .index("by_artifact", ["artifactKind", "artifactId"]),

  // One member of one project (phase 1 of the project-workspace design, ADR
  // 0011): the role row that superseded the per-creator privacy decision
  // (stage 8's D1) — a project is a thin COLLABORATIVE workspace, and this
  // row is the whole grant. `userId` is the auth() hook's identity.subject
  // (the Better Auth user id, the same string schemas.createdBy holds).
  //
  // Roles: "owner" (manage members, delete the project, full write), "editor"
  // (write everything in the project — artifacts, drafts, presses, project
  // title/description), "viewer" (read the workspace and the project-held
  // drafts, never write). The role order is total: owner > editor > viewer;
  // access checks ask "at least" one of them.
  //
  // The creator's owner row is inserted in the SAME transaction as the
  // project (projects.create), and setRole/removeMember refuse to touch it —
  // exactly one invariant, "a project always has its creator as an owner",
  // with no last-owner election logic. NOT an array on the project doc: the
  // same membership-rows-not-an-array rule as projectArtifacts (guidelines).
  projectMembers: defineTable({
    projectId: v.id("projects"),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer")),
    userId: v.string(),
  })
    // The workspace/member checks: a project's membership.
    .index("by_project", ["projectId"])
    // The browser read: every project the caller belongs to.
    .index("by_user", ["userId"]),

  // ---------------------------------------------------------------------------
  // Layers and project-owned maps (phase 3 of the project-workspace design,
  // ADR 0012). Styling decoupled from data, QGIS-style: a LAYER is one
  // dataset reference plus its style/filter/labels/popup (kind "data") or an
  // ordered group of layers (kind "group") — a first-class, publishable
  // artifact of one project. A MAP is that project's canvas: an ordered list
  // of layer placements. Standalone component maps are retired with this
  // phase — a map exists only inside a project.
  // ---------------------------------------------------------------------------

  // One layer (ADR 0012): the styling half of the model's "Data layer" row.
  // Every write goes through layers.ts's role checks (editor-and-up of the
  // owning project; reads answer to members — a draft layer is
  // project-private like a project-held dataset draft; a PUBLISHED layer is
  // linkable by any signed-in user, the trusted-collaborator default, ADR
  // 0009).
  //
  // - kind "data": renders one dataset through the project membership named
  //   by `datasetMemberId` (a projectArtifacts row of kind "dataset") — the
  //   membership carries the pin/float version edge, so "dataset ref
  //   resolved/pinned at publish" resolves the pin's row at freeze time
  //   (layerVersions). The membership indirection is the point: restyle or
  //   sync the dataset without touching the layer, remove the dataset and
  //   the layer reads as missing (defensively, like every reference).
  // - kind "group": ordered children in `layerChildren` (rows, not arrays —
  //   the projectArtifacts rule), `opacity`/`visible` its own display state.
  //   A group is a layer too: it publishes, links, and clones exactly like a
  //   data layer (its version freezes the children's pinned versions).
  //
  // `style`/`filter`/`labels`/`popup` are the data kind's styling quadruple —
  // style is the typed path/circle paint shape the map editor writes (phase
  // 4's stored style replaces the client-only assignDatasetColors); filter is
  // the dataset's JSON-schema-filtered subset; labels/popup are field-picking
  // configs. All optional: a layer with none renders the dataset's default
  // appearance. `needsAttention` is the schema-drift flag: a dataset sync
  // that changes fields stamps the affected layers (see
  // consumption.syncReference → markLayersForDrift) instead of breaking them;
  // the next styling write clears it.
  layers: defineTable({
    // The data kind's dataset membership — absent (and meaningless) on groups.
    datasetMemberId: v.optional(v.id("projectArtifacts")),
    filter: v.optional(v.any()),
    labels: v.optional(v.any()),
    // "draft" (the working definition, project-visible) vs "published" (a
    // version exists — phase 5's publish flips it; link/clone gate on the
    // version CHAIN's existence until then, the existence-over-marker rule).
    lifecycle: v.union(v.literal("draft"), v.literal("published")),
    // The only required field (the UI rule: title required, the rest
    // optional, everywhere).
    name: v.string(),
    // The drift message — set by the sync-drift stamp, cleared by the next
    // styling write. A string (why), not a boolean (the UI says what moved).
    needsAttention: v.optional(v.string()),
    // The group kind's group-level transparency (0–1), phase 4's slider.
    opacity: v.optional(v.number()),
    popup: v.optional(v.any()),
    projectId: v.id("projects"),
    kind: v.union(v.literal("data"), v.literal("group")),
    style: v.optional(
      v.object({
        color: v.optional(v.string()),
        fillColor: v.optional(v.string()),
        fillOpacity: v.optional(v.number()),
        opacity: v.optional(v.number()),
        radius: v.optional(v.number()),
        weight: v.optional(v.number()),
      }),
    ),
    visible: v.boolean(),
  })
    // The project's Layers section and its role checks.
    .index("by_project", ["projectId"]),

  // One child placement inside a group layer — the membership-rows-not-
  // arrays rule applied to groups (an array on the group doc would rewrite
  // it on every reorder and grow unbounded). `order` is the draw/list
  // position, contiguous-ish like mapLayers' (only relative order matters;
  // removals may leave gaps the index scan orders through).
  //
  // `childLayerId` answers to ONE OF TWO TABLES by `childKind`:
  // - "owned": an app-side `layers` row of the same project (a data layer or
  //   another group — nesting lives only inside groups).
  // - "linked": a PINNED `layerVersions` row id — a foreign published layer's
  //   frozen version, referenced read-only exactly as its project pins it.
  layerChildren: defineTable({
    childKind: v.union(v.literal("owned"), v.literal("linked")),
    childLayerId: v.string(),
    groupId: v.id("layers"),
    order: v.number(),
  })
    .index("by_group", ["groupId", "order"])
    // The parent lookup ("which group holds this layer") — the cycle guard's
    // and reparent's walk, and the removal cascade. Extra to the design's
    // by_group: without it every parent check would scan the table.
    .index("by_child", ["childLayerId"]),

  // One frozen published definition of one layer — the append-only version
  // chain layer publishing mints (phase 5's action; the table and the
  // link/clone reads over it land here). Mirrors dataset versioning: rows
  // are never mutated, newest per layer is the head, and `versionLabel` is
  // the display name.
  //
  // `definition` is the frozen style/filter/labels/popup/opacity/visible/name
  // quadruple-plus (shapeless `v.any()` like every stored spec — a typed
  // validator would fork from the live table's fields they mirror).
  //
  // `dataset` freezes the data kind's resolved ref: the source membership and
  // the pin it carried at publish (pinnedRef/pinnedSchemaId, the component
  // dataset version) — the layer's data is pinned at publish, so later syncs
  // of the membership never move a published layer's data.
  //
  // `frozenChildren` is a group version's closure: each child as it was at
  // freeze — an owned child's own frozen version id, or a linked child's
  // pinned one. Deliberately an ARRAY on the version row: this is a frozen
  // snapshot of a human-scale group at a publish event, not live membership —
  // the layerChildren rows-not-arrays rule governs the mutable tree, exactly
  // as bundleRunMembers' bounded arrays govern press snapshots.
  layerVersions: defineTable({
    dataset: v.optional(
      v.object({
        pinnedRef: v.optional(v.string()),
        pinnedSchemaId: v.optional(v.string()),
        sourceMemberId: v.id("projectArtifacts"),
      }),
    ),
    definition: v.any(),
    frozenChildren: v.optional(
      v.array(
        v.object({
          childKind: v.union(v.literal("owned"), v.literal("linked")),
          childLayerId: v.string(),
          versionId: v.optional(v.string()),
        }),
      ),
    ),
    frozenAt: v.number(),
    layerId: v.id("layers"),
    versionLabel: v.string(),
  })
    // The version chain: a layer's published history, newest first.
    .index("by_layer", ["layerId"]),

  // One project-owned map (ADR 0012) — the canvas the model table names:
  // viewport/basemap plus the ordered root layer placements in `mapLayers`.
  // NOT a projectArtifacts membership: maps are project rows like layers but
  // reference nothing versioned themselves (a map's publish, phase 5,
  // snapshots its placements). Standalone component maps are retired with
  // this table.
  projectMaps: defineTable({
    basemap: v.optional(v.string()),
    description: v.optional(v.string()),
    // The only required field (the UI rule).
    name: v.string(),
    // Display order in the project's Maps section (append-assigned; gaps
    // after deletions are fine — relative order is all that renders).
    order: v.number(),
    projectId: v.id("projects"),
    // The saved camera — bounds [minLon, minLat, maxLon, maxLat] and zoom,
    // whatever the editor last captured (phase 4 writes it; `any` stays
    // open for its growth, the stored-spec precedent).
    viewport: v.optional(v.any()),
  })
    .index("by_project", ["projectId"])
    // The Maps section's display order — an ascending index scan IS the
    // section (the mapLayers by_map shape).
    .index("by_project_order", ["projectId", "order"]),

  // One root placement of a layer on a project map — rows, not arrays (the
  // projectArtifacts/layerChildren rule). `layerMemberId` names the layer
  // THROUGH ITS MEMBERSHIP (a projectArtifacts row of kind "layer" in the
  // map's own project): owned layers answer via their `layers` row, linked
  // ones via their pinned layerVersions row (the membership's artifactId).
  // `visible` is the map-local override of the layer's own `visible`.
  mapLayers: defineTable({
    layerMemberId: v.id("projectArtifacts"),
    mapId: v.id("projectMaps"),
    order: v.number(),
    visible: v.boolean(),
  }).index("by_map", ["mapId", "order"]),

  // One bundle press (roadmap 7b, #103; lifecycle doc §2/§5-§6, ADR 0008):
  // the syncRuns/publishAttempts-pattern durability row at the BUNDLE level —
  // one row per press, so a killed browser rejoins its press and resumes only
  // the members that never finished (per-member durability is already each
  // publishAttempt's; this row is what makes resume EXACT — which members are
  // done lives here, not in a client re-walk). Deliberately APP-SIDE: the
  // component never learns projects exist (lifecycle §4).
  //
  // Recorded decisions this table pins:
  // - **The collection is created once and REUSED** across presses (the
  //   promoted bundle role is behavioral — component schema.ts collections
  //   gain nothing): `collectionId` is that component row, a plain string per
  //   the host-boundary id rule, absent until the press's collection leg
  //   runs. Nothing else links a project to a collection — this row is the
  //   link (the project→collection leg the 7a schema had no place for).
  // - **Bundle-level version identity: declined.** The bundle itself does not
  //   version; history is the sequence of these rows plus each member's own
  //   version chain. The collection is a live component row (name/description
  //   only), so the published form floats by construction — the lifecycle
  //   doc's §9 lean, made concrete.
  // - **Republish semantics (the issue's open item, picked): a re-press
  //   re-promotes every member** — each draft/derived member publishes a NEW
  //   attempt (vN+1, append-only; the acceptance's "republishing creates new
  //   version rows, never mutating prior ones") — because no per-dataset
  //   change signal exists (a draft carries no updated-at stamp), so
  //   changed-inputs-only would be a guess. Keep-N retention bounds the
  //   chains; members whose last attempt is still in flight JOIN it
  //   (publish.start's join-or-revive), never fork.
  bundleRuns: defineTable({
    // The component collection row this press promoted the project into.
    collectionId: v.optional(v.string()),
    // Attribution (the publishAttempts stance) — since stage 8 (#104) the
    // press is creator-private anyway: start and every leg mutation check
    // the RUN'S PROJECT's creator, and this stamp names them.
    createdBy: v.string(),
    error: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
    lastProgressAt: v.number(),
    // The project's description at press time — the promoted collection's.
    projectDescription: v.optional(v.string()),
    projectId: v.id("projects"),
    startedAt: v.number(),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    // The project's title at press time — the promoted collection's name.
    title: v.string(),
  }).index("by_project", ["projectId"]),

  // One member of one bundle press — the per-member checkpoint the client
  // orchestrator records against (guidelines: child items get their own
  // table, never an unbounded array on the run row). Rows are born in the
  // press's canonical WRITE order (datasets, then derived — phase 3 of the
  // project-workspace design retired map members with the standalone maps;
  // layer members join the press in phase 5), so the by_run scan IS the
  // order.
  bundleRunMembers: defineTable({
    // The per-member publish attempt, once the client started one (plain
    // string across the host boundary — it IS a host id, but member rows are
    // written before the attempt exists).
    attemptId: v.optional(v.string()),
    // What this member is: a component dataset id or a derivedDatasets
    // registry row id — plain strings (the projectArtifacts precedent).
    // `kind` says which table answers.
    datasetKey: v.string(),
    error: v.optional(v.string()),
    // Dataset members: the draft's group, so the frozen row joins it at the
    // collection leg (group layers would otherwise render nothing post-publish
    // — frozen rows are born ungrouped). Component group id, plain string.
    groupId: v.optional(v.string()),
    kind: v.union(v.literal("dataset"), v.literal("derived")),
    // The frozen row this member produced (draft/derived publishes), absent
    // until the client records the outcome.
    publishedSchemaId: v.optional(v.string()),
    // False for members with nothing to freeze (an already-published dataset
    // referenced into the project joins the bundle as a MEMBER only — it
    // gains collection membership, never a new version).
    publish: v.boolean(),
    runId: v.id("bundleRuns"),
    // "pending" (not started) → "publishing" (client started the attempt) →
    // "published" (frozen) for publishable members; already-published dataset
    // members are born "referenced". "failed" leaves the run partial —
    // completed members keep their frozen rows (append-only; the only teardown
    // is publish.ts's half-built-row sweep). Open union: future stages grow it
    // additively.
    status: v.union(
      v.literal("pending"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("referenced"),
      v.literal("failed"),
    ),
  }).index("by_run", ["runId"]),

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
  // tags.getVersionDelta), so only sequential pairs are stored. `truncated`
  // (#126) marks a delta whose sides sat at the VERSION_DIFF_LIMIT read
  // budget — the counts cover the first 2,000 rows per side, and the UI says
  // so instead of serving the bounded diff as the whole truth.
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
    truncated: v.optional(v.boolean()),
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

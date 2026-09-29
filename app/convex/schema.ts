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
    // Attribution (ADR 0007), like every host-written row. Deliberately NOT
    // enforced: per-creator isolation is stage 8 (roadmap) — until then the
    // attempt is joinable by any signed-in editor, exactly like a saved
    // derivedDatasets draft (the registry's recorded stance).
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
    plannedGeometryType: v.optional(v.string()),
    plannedKind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    plannedSchema: v.optional(v.any()),
    plannedTotalRows: v.optional(v.number()),
    publishKey: v.string(),
    publishedSchemaId: v.optional(v.string()),
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
    .index("by_status_and_source", ["status", "sourceDatasetId"]),

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
    // stage 7b (#103) adds "map" (a bundle press mints one float row per
    // dataset layer target — the layer's chain resolution leg, mapLayers
    // themselves untouched) and "fork" (fork-as-reference: one float row per
    // project membership on a dataset — consumerId is the projectArtifacts
    // row id, so removing the membership removes the edge with it). Modes
    // mean the same thing for every kind: float = at head, pin = the
    // pinnedRef row.
    consumerKind: v.union(v.literal("derived"), v.literal("map"), v.literal("fork")),
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
    .index("by_source", ["sourceDatasetId"]),

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
  // `createdBy` is attribution (ADR 0007) with the recorded publishAttempts
  // stance: NOT an ownership check on writes — any signed-in editor may
  // modify a project, exactly like a saved derived draft (per-creator
  // isolation is stage 8). READS are creator-scoped — `projects.list` returns
  // the caller's own rows and `projects.get` answers null to anyone else —
  // which is what keeps the issue's "other users' and anonymous views never
  // show the drafts" true for everything this stage introduces. Anonymous
  // callers never get this far (rejected at the auth choke point, auth.ts).
  projects: defineTable({
    // The auth() hook's identity.subject — the Better Auth user id, the same
    // string schemas.createdBy holds. Attribution, not a check (see above).
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
  projectArtifacts: defineTable({
    // Attribution only, same stance as projects.createdBy.
    addedBy: v.string(),
    // The referenced artifact — ONE plain-string id space across kinds:
    // artifactKind says which table answers (a component dataset id, a
    // derivedDatasets registry row id, or a component map id). Component
    // tables don't exist in this deployment's generated data model, so no
    // v.id() of them is possible here (the datasetBindings precedent).
    // NEVER overloaded onto a spec's dependsOn or any component field.
    artifactId: v.string(),
    // Open literal union on purpose (the derivedDatasets.status /
    // consumerReferences.consumerKind precedent): stage 9's analysis
    // artifacts join additively, no migration.
    artifactKind: v.union(v.literal("dataset"), v.literal("derived"), v.literal("map")),
    projectId: v.id("projects"),
  })
    // The workspace read: everything in one project.
    .index("by_project", ["projectId"])
    // The reverse lookup ("which projects hold this artifact") and cleanup.
    .index("by_artifact", ["artifactKind", "artifactId"]),

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
    // Attribution only (the publishAttempts stance): any signed-in editor may
    // press; per-creator isolation is stage 8.
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
  // press's canonical WRITE order (datasets, then derived, then maps — the
  // order the publish legs must run in), so the by_run scan IS the order.
  bundleRunMembers: defineTable({
    // The per-member publish attempt, once the client started one (plain
    // string across the host boundary — it IS a host id, but member rows are
    // written before the attempt exists).
    attemptId: v.optional(v.string()),
    // What this member is: a component dataset id, a derivedDatasets registry
    // row id, or a component map id — plain strings (the projectArtifacts
    // precedent). `kind` says which table answers.
    datasetKey: v.string(),
    error: v.optional(v.string()),
    // Dataset members: the draft's group, so the frozen row joins it at the
    // collection leg (group layers would otherwise render nothing post-publish
    // — frozen rows are born ungrouped). Component group id, plain string.
    groupId: v.optional(v.string()),
    kind: v.union(v.literal("dataset"), v.literal("derived"), v.literal("map")),
    // Map members: the DATASET-layer target ids the press mints map
    // references for (the chain-resolution leg). Collection/group layers
    // expand live and need none.
    layerTargets: v.optional(v.array(v.string())),
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
    // members are born "referenced"; map members go "pending" → "linked".
    // "failed" leaves the run partial — completed members keep their frozen
    // rows (append-only; the only teardown is publish.ts's half-built-row
    // sweep). Open union: future stages grow it additively.
    status: v.union(
      v.literal("pending"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("referenced"),
      v.literal("linked"),
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

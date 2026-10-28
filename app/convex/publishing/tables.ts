import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Host tables for projects, publish attempts and bundle runs (docs/project-workspace-design.md, docs/catalog-lifecycle-design.md).
 * Spread into `convex/schema.ts` with one line (ADR 0014).
 */
export const publishingTables = {
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
  // `createdBy` is attribution (ADR 0007) and, since stage 8 (#104, the
  // recorded D1 decision: projects are per-creator private), the OWNERSHIP
  // key: every write goes through projects.projectForWrite's creator check
  // (bundles.ts's press rides the same guard), and every read is
  // creator-scoped — `projects.list` returns the caller's own rows and
  // `projects.get` answers null to anyone else — which is what keeps the
  // issue's "other users' and anonymous views never show the drafts" true
  // for everything this stage introduces. Anonymous callers never get this
  // far (rejected at the auth choke point, auth.ts).
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
  projectArtifacts: defineTable({
    // Attribution, same stance as projects.createdBy (ownership rides the
    // membership's project's creator check — stage 8).
    addedBy: v.string(),
    // The referenced artifact — ONE plain-string id space across kinds:
    // artifactKind says which table answers (a component dataset id, a
    // derivedDatasets registry row id, or a component map id). Component
    // tables don't exist in this deployment's generated data model, so no
    // v.id() of them is possible here (the datasetBindings precedent).
    // NEVER overloaded onto a spec's dependsOn or any component field.
    artifactId: v.string(),
    // Open literal union on purpose (the derivedDatasets.status /
    // consumerReferences.consumerKind precedent). Stage 9 (#105) ultimately
    // did NOT need to exercise it: an analysis is a derivedDatasets registry
    // row (a sql operation is just another spec kind), so analyses join
    // projects as artifactKind "derived" — no new lifecycle concepts, no
    // migration, and this union stayed open for whatever a later stage adds.
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
};

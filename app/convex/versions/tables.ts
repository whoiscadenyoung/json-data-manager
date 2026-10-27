import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Host tables for the derived-dataset registry and versioned consumption: consumer references, version policies and stored tag deltas (docs/catalog-lifecycle-design.md).
 * Spread into `convex/schema.ts` with one line (ADR 0014).
 */
export const versionTables = {
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
};

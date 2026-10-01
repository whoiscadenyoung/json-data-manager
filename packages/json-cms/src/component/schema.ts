import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { geometryArgsValidator, geometryTypeValidator } from "../shared/geojson/validators.js";

/**
 * The `lineage` object a frozen version dataset carries (see the `schemas`
 * field below). Declared once so the table and `createSchema`'s argument
 * validator can never drift. Additive-growth shape (the lifecycle-flag
 * precedent): every field the materialized publish (roadmap 5b) added is
 * OPTIONAL, so pre-5b rows — the tag path's narrow
 * `{frozenAt, snapshotRef?, sourceSchemaId, versionLabel}` — keep reading
 * untouched.
 *
 * The generalization (docs/catalog-lifecycle-design.md §7): a version's
 * lineage names its recipe and source versions, not just one source ref.
 * - `sourceSchemaId` became OPTIONAL: an imported draft's publish anchors
 *   its chain here as before, but a derived dataset's publish has no
 *   component source row to point at (the derived draft is a HOST-side
 *   registry row) — its chain anchor is the host id in `sourceKey` instead.
 *   Both stay absent/unset on rows that are their own origin.
 * - `sourceKey` is a plain string per the host-boundary id rule (the
 *   datasetBindings precedent: component tables don't exist in the host's
 *   generated data model, so host ids travel untyped and each side asks its
 *   own tables in turn).
 * - `recipe` is the stored TransformSpec, shapeless (`v.any()`) exactly
 *   like the registry's `spec` column — a per-operation validator would
 *   reject future operation kinds and force a stored-spec migration.
 * - `sourceVersions` records what each read source contributed at freeze
 *   time: the source's id and, when the source was itself a frozen version,
 *   that version's ref and freeze time — the seam stage 6's "source
 *   published vN" badge compares against.
 */
export const lineageValidator = v.object({
  frozenAt: v.number(),
  recipe: v.optional(v.any()),
  snapshotRef: v.optional(v.string()),
  sourceKey: v.optional(v.string()),
  sourceSchemaId: v.optional(v.id("schemas")),
  sourceVersions: v.optional(
    v.array(
      v.object({
        datasetId: v.string(),
        frozenAt: v.optional(v.number()),
        ref: v.optional(v.string()),
      }),
    ),
  ),
  versionLabel: v.string(),
});

export default defineSchema({
  // A named grouping of datasets. Top-level organizational unit — e.g. "Grant
  // data" holding every dataset for a multi-year grant program.
  collections: defineTable({
    description: v.optional(v.string()),
    name: v.string(),
  }),

  // A tighter-coupled set of related datasets — e.g. "SMART Grant 2025"
  // holding just that year's polygons + points datasets, which don't make
  // sense on their own. Usually lives inside one `collections` doc, but may
  // also float standalone (no `collectionId`); never nests inside another
  // group.
  groups: defineTable({
    collectionId: v.optional(v.id("collections")),
    description: v.optional(v.string()),
    name: v.string(),
  }).index("by_collection", ["collectionId"]),

  // A saved, custom arrangement of layers rendered together on one map —
  // e.g. one map per corridor study, mixing whole collections with individual
  // datasets. Purely a view concern: a map references datasets through its
  // layers but never reorganizes them.
  maps: defineTable({
    description: v.optional(v.string()),
    name: v.string(),
  }),

  // One layer of a map: a pointer at a whole collection, a group, a single
  // dataset, or a host-side derived dataset, plus its display state.
  // `targetType` names what `targetId` points into. Collection/group layers
  // expand to every geospatial dataset they currently contain at read time —
  // membership changes flow through live, no denormalization. Deletion of a
  // component target cascades to its layer rows (see
  // deleteSchema/deleteGroup/deleteCollection), so a component layer never
  // dangles. `order` is the draw/list position — written contiguously by
  // addMapLayer, swapped by moveMapLayer, and may hold gaps after removals
  // (only relative order matters; `by_map` indexes it so an index scan yields
  // draw order directly).
  //
  // The "derived" target (roadmap 3a, #96; ADR 0005): `targetId` holds a
  // HOST-side registry id (the app's derivedDatasets row — a plain string
  // here, the datasetBindings precedent). The component cannot query host
  // tables, so the schema only narrows the stored shape: the string branch is
  // shape-checked by normalizeMapLayerTarget at write time, and existence is
  // the HOST wrapper's job (api.maps.addDerivedLayer validates the registry
  // row before calling addMapLayer). Cascade deletes deliberately do NOT
  // cover host ids — deleting a derived dataset leaves its layer rows in
  // place, and readers answer "deleted derived dataset" defensively, exactly
  // like the other dangling-target cases they already handle. mapLayers /
  // mapLayerOverrides are the structure stage 7b's bundle publish must
  // preserve ("published shapes identical") — this widening adds a target
  // kind without touching that structure.
  mapLayers: defineTable({
    mapId: v.id("maps"),
    order: v.number(),
    // The trailing string branch makes every id valid as a plain string; the
    // per-targetType runtime checks in normalizeMapLayerTarget (plus the
    // host wrapper for "derived") are what keep stored rows pointing at real
    // targets.
    targetId: v.union(v.id("collections"), v.id("groups"), v.id("schemas"), v.string()),
    targetType: v.union(
      v.literal("collection"),
      v.literal("group"),
      v.literal("dataset"),
      v.literal("derived"),
    ),
    visible: v.boolean(),
  })
    .index("by_map", ["mapId", "order"])
    .index("by_target", ["targetId"]),

  // Per-child visibility overrides within one layer, keyed by `childKey` —
  // `group:<id>` for a group inside a collection layer, `dataset:<id>` for a
  // dataset (whether a direct member of the collection, a group member, or
  // the layer's own single target). A child is visible when its layer is
  // visible AND its override (if any) is true; overrides on a group child
  // cascade down to its member datasets client-side (a dataset child of a
  // hidden group child renders hidden regardless of its own override). One
  // row per `{layerId, childKey}` — rows exist only for children the user
  // has explicitly toggled, so membership changes flow through live like the
  // layers themselves. Deleted with their layer (see removeMapLayer), so
  // they never dangle.
  mapLayerOverrides: defineTable({
    childKey: v.string(),
    layerId: v.id("mapLayers"),
    visible: v.boolean(),
  }).index("by_layer", ["layerId"]),

  // Many-to-many membership between datasets and collections — a dataset can
  // live in any number of collections, and a collection holds any number of
  // datasets. One row per `{dataset, collection}` pair, deleted and re-derived
  // only through addSchemaToCollection/removeSchemaFromCollection (which
  // enforce uniqueness of the pair). Group membership is deliberately
  // independent of these rows — see `groups` and setSchemaGroup.
  schemaCollections: defineTable({
    collectionId: v.id("collections"),
    // The owning dataset's `kind`, denormalized onto the membership row so
    // "which of this collection's datasets are geospatial" reads membership
    // rows only, with no `schemas` doc fetch per membership (issue #54's
    // collection-level N+1). Kept in sync where `kind` itself changes:
    // stamped at insert time, and `startGeospatialConversion` rewrites the
    // dataset's membership rows when it flips a dataset to geospatial.
    // Absent on pre-field rows — `listGeospatialSchemaIdsByCollection`
    // falls back to reading the schema doc for just those rows, so the
    // denormalization only ever saves reads, never changes results.
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    schemaId: v.id("schemas"),
  })
    .index("by_schema", ["schemaId"])
    .index("by_collection", ["collectionId"]),

  schemas: defineTable({
    // The host's identity string for whoever created this dataset — stamped
    // by `createSchema` from its optional `actorId` argument (the exposeApi
    // wrapper forwards its `auth` hook's return value there; host flows that
    // call the component directly may pass their own, or omit it). Opaque to
    // the component by design: the host decides what the string means (a
    // user id, "system", …) and how to resolve it for display. Absent on
    // datasets created before the field existed.
    createdBy: v.optional(v.string()),
    // Optional — a dataset needs a title, but a description is fine to omit.
    description: v.optional(v.string()),
    // Absent/undefined means "standard" (a plain JSON-schema dataset). No
    // Migration needed for existing docs — they simply have no `kind`.
    geometryType: v.optional(geometryTypeValidator), // Only meaningful when kind === "geospatial"
    // A dataset can belong to at most one group. Independent of collection
    // memberships (see `schemaCollections`) — a grouped dataset isn't
    // implicitly in the group's collection.
    groupId: v.optional(v.id("groups")),
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    // Catalog lifecycle state (roadmap 5a, #99; docs/catalog-lifecycle-design.md
    // §3): `"draft"` hides the dataset from the catalog's list reads
    // (`listSchemas`/`listSchemaSummaries` — see lib.ts), `"published"` and
    // ABSENT both show it. Absent-reads-as-published is the polarity that
    // keeps every pre-field row and every dataset created through today's
    // flows catalog-visible without a backfill — which is also why this is a
    // literal union, not a boolean: stages 5b/6 grow it with new states
    // (republish/versioning) instead of flipping polarity. The only writer is
    // host-side code invoking the component directly (the `source`/`lineage`
    // pattern — the exposeApi wrapper deliberately omits the field, and 5b's
    // publish action writes it the same way); until then no user flow
    // produces drafts.
    lifecycle: v.optional(v.union(v.literal("draft"), v.literal("published"))),
    // Published-visibility control (roadmap stage 8, #104; lifecycle doc §4's
    // consumer row, revisited for multi-user): who may read this dataset once
    // it is catalog-visible. "everyone" — and ABSENT, so every pre-field row —
    // is readable by any signed-in user (today's behavior, unchanged);
    // "author" restricts catalog reads to the row's own creator (`createdBy`).
    // Host-flow-only like `lifecycle`: written by the host's
    // setSchemaVisibility flow (creators flipping their own rows) and
    // inherited from the draft at publish (the freeze passthrough), never
    // through an exposeApi wrapper. Enforced server-side in the catalog
    // enumerations (isVisibleToViewer in lib.ts) and in the host's by-id auth
    // policy — never in the UI. Deliberately carried on the dataset row
    // itself, never on project-shaped data: nothing published knows projects
    // exist (lifecycle §4).
    publishedVisibility: v.optional(v.union(v.literal("author"), v.literal("everyone"))),
    // Per-dataset edit policy (issue #124, ADR 0010): who may WRITE this
    // dataset. "open" — and ABSENT, so every pre-field row — keeps the
    // trusted-collaborator default (ADR 0009: any signed-in user); "locked"
    // answers writes only to the row's creator (`createdBy`). Read visibility
    // is `publishedVisibility`'s job and stays orthogonal: the two fields
    // compose into the four public/private × open/locked combinations. The
    // component stays auth-less, so enforcement is the HOST's `auth` choke
    // point plus its explicit host-flow checks (the `setSchemaVisibility`
    // pattern); the only writer is the host's `setEditPolicy` flow — never an
    // exposeApi wrapper. A literal union (not a boolean) so the recorded
    // growth path — a later `{ mode: "team", teamId }` — extends additively,
    // the same way `lifecycle` grew.
    editPolicy: v.optional(v.union(v.literal("open"), v.literal("locked"))),
    // Denormalized dataset-level summary, maintained incrementally by the
    // entry/geometry mutations in component/lib.ts (never recomputed from a
    // full scan). `featureCount` is kept exactly accurate — cheap to keep
    // exact, and users notice when it's wrong. `boundingBox` is a
    // best-effort, monotonically NON-SHRINKING envelope: an insert/replace
    // expands it via `unionBbox`, but a delete/clear never shrinks it back
    // down (that would require rescanning every remaining geometry in the
    // dataset, defeating the point of denormalizing). So after deletions it
    // may be larger than the dataset's true current extent — fine for its
    // actual use (map default viewport, list-page summary badge), just not
    // something to treat as exact.
    featureCount: v.optional(v.number()),
    // Total rows in the dataset — like `featureCount`, kept exactly accurate
    // by the entry mutations (see `applyEntryCountDelta` in lib.ts). This is
    // the count the UI can afford to read on every list page: Convex has no
    // count operator, so without it a "Data (N)" badge would mean reading
    // every entry doc (and their full `data` payloads) up to the 16 MiB
    // per-execution cap. Optional + absent on pre-field rows — the one-off
    // `backfillDatasetSummaries` fills them in; readers treat absent as
    // "unknown" and fall back to what the loaded pages show.
    entryCount: v.optional(v.number()),
    boundingBox: v.optional(v.array(v.number())), // [minLon, minLat, maxLon, maxLat]
    // Rendering-cache bookkeeping for the tile-archive path (#58): every
    // geometry-affecting write bumps `mapTileCacheVersion` (see
    // `bumpMapTileCacheVersion` in lib.ts) so a stale rebuild can detect
    // itself, and the remaining four fields point at the current archive —
    // set atomically by `setMapTileArchive` only when its `expectedVersion`
    // still matches. All five are absent on datasets that never had an
    // archive; an absent version reads as 0.
    //
    // The version is MONOTONIC for the dataset's lifetime (issue #129,
    // revising the recorded exact-reset decision): clearing the data bumps
    // it like any other geometry-affecting write instead of resetting it to
    // 0. A rebuild snapshotted at the pre-clear version N — or an OPFS pin
    // keyed (schemaId, N) — can therefore never be satisfied by post-clear
    // data re-climbing to N, because the counter never returns to N.
    mapTileCacheVersion: v.optional(v.number()),
    mapTileArchiveStorageId: v.optional(v.id("_storage")),
    mapTileArchiveBytes: v.optional(v.number()),
    mapTileArchiveMaxZoom: v.optional(v.number()),
    // The version the CURRENT installed archive was built from — the
    // `expectedVersion` snapshot its worker took before generating. Unlike
    // `mapTileCacheVersion` (which keeps moving with every geometry write),
    // this only changes when a new archive installs, which is what makes
    // staleness observable: `meta.version` (this field, surfaced by
    // `getMapTileArchiveMeta`) behind `mapTileCacheVersion` means edits
    // landed after the archive was built.
    mapTileArchiveBuiltVersion: v.optional(v.number()),
    // True when this dataset normalizes geometry coordinates to
    // GEOMETRY_SIMPLIFY_DECIMAL_PLACES (6dp, ~0.11 m) on every write — set at
    // creation via the importer's "Simplify geometry" checkbox, or by
    // startSimplification for an existing dataset. Absent means no
    // simplification (all pre-flag datasets).
    simplifyGeometry: v.optional(v.boolean()),
    // Set when this dataset is a read-only projection of a connected external
    // source (the host app's bound-datasets integration): `name` identifies
    // the source (e.g. a table or feed the host syncs from). The component
    // itself enforces the read-only rule: data mutations on a `source`- or
    // `lineage`-marked dataset are rejected unless the host's sync/ingest
    // flow attests them with `boundWrite` (see `assertDataWritable` in
    // lib.ts) — hosts additionally gate their own wrapped mutations.
    source: v.optional(v.object({ name: v.string() })),
    // Set when this dataset is a frozen point-in-time version — of a bound
    // live dataset (the host's tag-ingest flow, docs/bound-datasets-design.md
    // §6) or a materialized publish (roadmap 5b; lifecycle doc §2/§7). The
    // shared shape lives in `lineageValidator` above; the per-field docs
    // there cover the generalized (recipe + source versions) form. Two
    // indexes serve the version reads: "versions of X" listings (only rows
    // with `sourceSchemaId` set appear there) and the already-frozen lookup
    // by `snapshotRef` (the host's idempotency key — a ref never freezes
    // twice). Like `source`, its presence makes the dataset read-only at the
    // component level (see `assertDataWritable` in lib.ts).
    lineage: v.optional(lineageValidator),
    schema: v.any(), // JSON schema object
    // The exact file the dataset was imported from, kept in file storage so
    // it can be re-downloaded even though every stored geometry was
    // potentially rounded. Uploaded by the client alongside the row chunks
    // and attached by `startImport`; only set for imports that provided one.
    sourceFileStorageId: v.optional(v.id("_storage")),
    sourceFileName: v.optional(v.string()),
    sourceFileSize: v.optional(v.number()),
    title: v.string(),
    uiSchema: v.optional(v.any()), // RJSF UI schema object
  })
    .index("by_group", ["groupId"])
    .index("by_lineage_source", ["lineage.sourceSchemaId"])
    .index("by_lineage_snapshotRef", ["lineage.snapshotRef"]),

  entries: defineTable({
    data: v.any(), // Entry data conforming to the schema
    // Pointer to the heavy coordinate payload in `geometries`, plus a tiny
    // denormalized copy of its top-level type — enough for the
    // properties-only table view (a type column / "No geometry") with zero
    // joins. The authoritative coordinates live only in `geometries`, never
    // Here, so reading a page of entries never pulls geometry payloads along
    // for the ride.
    geometryId: v.optional(v.id("geometries")),
    geometryType: v.optional(geometryTypeValidator),
    schemaId: v.id("schemas"),
  }).index("by_schema", ["schemaId"]),

  // One row per entry that currently has a geometry — a 1:1 relationship
  // with `entries`, not many:many. A GeoJSON Feature has exactly one
  // `geometry` member, but that member can itself be a MultiPolygon /
  // MultiPoint / MultiLineString — GeoJSON's own built-in way of
  // representing "many parts as one geometry". There's no requirement today
  // for one entry to carry more than one independent geometry value, so a
  // join table would add real complexity (junction rows, extra queries) for
  // a use case that doesn't exist yet. This table is still a clean seam to
  // add one later if that ever changes, without touching `entries` again.
  //
  // The heavy coordinate payload is NEVER stored as nested Convex arrays
  // (`geometryArgsValidator`'s shape) — real-world GIS data routinely has a
  // single ring/position-list with tens of thousands of vertices, and Convex
  // caps any single array (including one nested inside a document/argument)
  // at 8192 elements. Instead the geometry is serialized to JSON text, which
  // has no such cap, and stored one of two ways:
  //  - `geometryJson`: inline, when the JSON text comfortably fits under
  //    Convex's ~1 MiB per-document limit (see INLINE_GEOMETRY_BYTE_LIMIT in
  //    lib.ts). This is the common case — most geometries land here.
  //  - `geometryStorageId`: a file-storage blob holding the same JSON text,
  //    for geometries too large to fit inline (measured up to ~4 MB in real
  //    datasets) — file storage has no document-size or array-length ceiling.
  // Exactly one of the two is set on any row written by current code.
  //
  // `geometry` (the old inline nested-array field) is kept declared, but
  // optional and no longer written, purely so pre-migration rows already
  // holding it don't fail schema validation — see `resolveGeometryOutput` in
  // lib.ts, which normalizes it away for every reader.
  geometries: defineTable({
    bbox: v.optional(v.array(v.number())), // This geometry's own bounding box
    entryId: v.id("entries"),
    /** @deprecated legacy inline shape — see the table's doc comment above. */
    geometry: v.optional(geometryArgsValidator),
    geometryJson: v.optional(v.string()),
    geometryStorageId: v.optional(v.id("_storage")),
    schemaId: v.id("schemas"), // Denormalized for the by-schema index (map view reads)
    type: geometryTypeValidator, // Denormalized copy of geometry.type for filtering/scanning without touching the payload
  })
    .index("by_entry", ["entryId"])
    .index("by_schema", ["schemaId"]),

  // Denormalized index of every outgoing foreign reference (see
  // ../shared/reference.ts): one row per `{sourceEntry, field, targetEntry}`
  // pointer, kept in sync with `entries.data` by the entry mutations in
  // lib.ts (deleted and re-derived from scratch on every create/update of the
  // source entry — reference fields per entry are few, so this is cheap).
  // Exists purely so "what references this entry?" (reverse lookup) is an
  // indexed query instead of a full scan of every other dataset's entries.
  references: defineTable({
    // The source entry's property name holding the reference(s) — lets a
    // reverse-lookup UI label which field on the source entry points here.
    fieldName: v.string(),
    sourceEntryId: v.id("entries"),
    // Denormalized from the source entry, for bulk cleanup when a whole
    // dataset is deleted without loading every one of its entries first.
    sourceSchemaId: v.id("schemas"),
    targetEntryId: v.id("entries"),
    // Denormalized from the target entry, for bulk cleanup when the target
    // dataset is deleted (its entries vanish, so anything pointing at them
    // must too, even though the pointers themselves live on other datasets).
    targetSchemaId: v.id("schemas"),
  })
    .index("by_source_entry", ["sourceEntryId"])
    .index("by_source_schema", ["sourceSchemaId"])
    .index("by_target_entry", ["targetEntryId"])
    .index("by_target_schema", ["targetSchemaId"]),

  // Tracks a batched, workflow-driven import of a dataset's entries so the
  // Client can monitor progress. The client splits the row payload into
  // several small chunks itself (each already comfortably small enough for
  // the component's per-chunk action to parse in Convex's default action
  // runtime — see lib.ts's `insertChunkFromStorage`; components cannot use
  // the Node runtime at all, so no server-side step can safely hold a whole
  // multi-tens-of-MB upload at once) and uploads each to its own storage blob.
  imports: defineTable({
    // Per-chunk completion journal (issue #129): one entry per chunk whose
    // rows are durably inserted — written in the SAME transaction as the
    // inserts (`insertEntriesChunkInternal`), so a workflow step that
    // crashed after committing but before returning replays as a no-op
    // (it returns the recorded row count instead of inserting twice).
    // `rows` is what the replay reports, keeping `processed` exact.
    completedChunks: v.optional(v.array(v.object({ index: v.number(), rows: v.number() }))),
    error: v.optional(v.string()),
    processed: v.number(),
    schemaId: v.id("schemas"),
    // Rows the run deliberately did NOT process, surfaced rather than
    // silently dropped (issue #129): the simplify workflow counts malformed
    // payloads and rows another write touched mid-run (the compare-and-swap
    // skip). Absent for runs that never skip (imports, conversion).
    skipped: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    /** @deprecated superseded by `storageIds` (one blob per client-uploaded chunk) — kept optional so a pre-migration row doesn't fail schema validation. */
    storageId: v.optional(v.id("_storage")),
    storageIds: v.optional(v.array(v.id("_storage"))), // One already-small, client-uploaded chunk blob per entry.
    total: v.number(),
    workflowId: v.optional(v.string()),
  }).index("by_schema", ["schemaId"]),

  // Server-issued upload provenance (issue #131): one row per upload URL the
  // component hands out (`generateUploadUrl`). The row is the receipt that a
  // storage id COULD only come from an upload this server invited — consumers
  // (`startImport`'s client path, the host's chunk-registration and
  // tile-install flows) claim the row by its id, and a claim against a
  // missing, already-used, or differently-scoped row rejects the id. An
  // unclaimed row (the client never presented its blob) is what the
  // abandoned-upload sweep (`host_support.sweepAbandonedUploads`) deletes.
  pendingUploads: defineTable({
    // Set when the row's upload URL was minted for a specific target — the
    // host's publish-attempt id (chunk registration) or the component schema
    // id (imports, tile installs). Absent on host-internal issuances (the
    // tag ingest uploads server-side); an absent scope can never satisfy a
    // claim, so unscoped URLs stay unregistrable by construction.
    scope: v.optional(v.string()),
  }),
});

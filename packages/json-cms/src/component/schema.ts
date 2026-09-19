import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { geometryArgsValidator, geometryTypeValidator } from "../shared/geojson/validators.js";

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

  // One layer of a map: a pointer at a whole collection, a group, or a single
  // dataset, plus its display state. `targetType` names the table `targetId`
  // points into (the union of typed ids makes a mismatched pair
  // unrepresentable). Collection/group layers expand to every geospatial
  // dataset they currently contain at read time — membership changes flow
  // through live, no denormalization. Deletion of a target cascades to its
  // layer rows (see deleteSchema/deleteGroup/deleteCollection), so a layer
  // never dangles. `order` is the draw/list position — written contiguously
  // by addMapLayer, swapped by moveMapLayer, and may hold gaps after
  // removals (only relative order matters; `by_map` indexes it so an index
  // scan yields draw order directly).
  mapLayers: defineTable({
    mapId: v.id("maps"),
    order: v.number(),
    targetId: v.union(v.id("collections"), v.id("groups"), v.id("schemas")),
    targetType: v.union(v.literal("collection"), v.literal("group"), v.literal("dataset")),
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
    // the source (e.g. a table or feed the host syncs from). Data mutations
    // on the dataset belong to that source's sync flow, not to users —
    // hosts gate their own wrapped mutations on this field's presence.
    source: v.optional(v.object({ name: v.string() })),
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
  }).index("by_group", ["groupId"]),

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
    error: v.optional(v.string()),
    processed: v.number(),
    schemaId: v.id("schemas"),
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
});

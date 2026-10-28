import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The demo foreign app's tables — the "source of truth" side of the
 * bound-datasets PoC (docs/bound-datasets-design.md): restaurants, their
 * locations, the join between them, the foreign commit log, and the foreign
 * snapshot registry. Spread into `convex/schema.ts` with one line so the
 * demo is removable (docs/bound-datasets-design.md "Removing the demo
 * sources"). Core sync/versioning code never names these tables; it reads
 * them only through the `LocalSource` adapters in ./sources.
 */
export const demoSourceTables = {
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
};

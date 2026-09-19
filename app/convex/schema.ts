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

  // The binding registry — one row per json-cms dataset projected from a
  // source in this schema. `source` is a stable key for the source table
  // (today only "restaurantLocations"); `schemaId`/`collectionId` hold the
  // json-cms ids as plain strings, since component tables don't exist in
  // this deployment's generated data model. Sync state rides along so a
  // UI "synced N minutes ago" badge needs no extra queries.
  datasetBindings: defineTable({
    collectionId: v.optional(v.string()),
    lastSyncedAt: v.optional(v.number()),
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

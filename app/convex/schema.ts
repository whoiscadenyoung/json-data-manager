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
});

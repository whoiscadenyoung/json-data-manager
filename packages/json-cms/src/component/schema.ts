import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { geometryArgsValidator, geometryTypeValidator } from "../shared/geojson/validators.js";

export default defineSchema({
  schemas: defineTable({
    description: v.string(),
    // Absent/undefined means "standard" (a plain JSON-schema dataset). No
    // Migration needed for existing docs — they simply have no `kind`.
    geometryType: v.optional(geometryTypeValidator), // Only meaningful when kind === "geospatial"
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
    boundingBox: v.optional(v.array(v.number())), // [minLon, minLat, maxLon, maxLat]
    schema: v.any(), // JSON schema object
    title: v.string(),
    uiSchema: v.optional(v.any()), // RJSF UI schema object
  }),

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
  geometries: defineTable({
    bbox: v.optional(v.array(v.number())), // This geometry's own bounding box
    entryId: v.id("entries"),
    geometry: geometryArgsValidator, // The heavy payload: full coordinates
    schemaId: v.id("schemas"), // Denormalized for the by-schema index (map view reads)
    type: geometryTypeValidator, // Denormalized copy of geometry.type for filtering/scanning without touching `geometry`
  })
    .index("by_entry", ["entryId"])
    .index("by_schema", ["schemaId"]),

  // Tracks a batched, workflow-driven import of a dataset's entries so the
  // Client can monitor progress. The payload lives in file storage.
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
    storageId: v.id("_storage"), // Uploaded rows payload (JSON array)
    total: v.number(),
    workflowId: v.optional(v.string()),
  }).index("by_schema", ["schemaId"]),
});

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  schemas: defineTable({
    title: v.string(),
    description: v.string(),
    schema: v.any(), // JSON schema object
    uiSchema: v.optional(v.any()), // RJSF UI schema object
  }),

  entries: defineTable({
    schemaId: v.id("schemas"),
    data: v.any(), // Entry data conforming to the schema
  }).index("by_schema", ["schemaId"]),

  // Tracks a batched, workflow-driven import of a dataset's entries so the
  // client can monitor progress. The payload lives in file storage.
  imports: defineTable({
    schemaId: v.id("schemas"),
    storageId: v.id("_storage"), // uploaded rows payload (JSON array)
    total: v.number(),
    processed: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
    workflowId: v.optional(v.string()),
  }).index("by_schema", ["schemaId"]),
});

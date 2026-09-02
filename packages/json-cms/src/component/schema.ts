import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  schemas: defineTable({
    description: v.string(),
    schema: v.any(), // JSON schema object
    title: v.string(),
    uiSchema: v.optional(v.any()), // RJSF UI schema object
  }),

  entries: defineTable({
    data: v.any(), // Entry data conforming to the schema
    schemaId: v.id("schemas"),
  }).index("by_schema", ["schemaId"]),

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

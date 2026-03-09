import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  schemas: defineTable({
    title: v.string(),
    description: v.string(),
    schema: v.any(), // JSON schema object
  }),
  
  entries: defineTable({
    schemaId: v.id("schemas"),
    data: v.any(), // Entry data conforming to the schema
  }).index("by_schema", ["schemaId"]),
});

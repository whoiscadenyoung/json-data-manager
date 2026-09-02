import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A couple of ordinary app tables to demonstrate exporting arbitrary data.
export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
  }),
  posts: defineTable({
    authorId: v.id("users"),
    title: v.string(),
    body: v.string(),
  }),
});

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }
    
    return await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) {
      throw new Error("Entry not found");
    }
    
    return entry;
  },
});

export const create = mutation({
  args: {
    schemaId: v.id("schemas"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }

    const entryId = await ctx.db.insert("entries", {
      schemaId: args.schemaId,
      data: args.data,
    });

    return entryId;
  },
});

export const createBulk = mutation({
  args: {
    schemaId: v.id("schemas"),
    dataArray: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }

    const ids = await Promise.all(
      args.dataArray.map((data) =>
        ctx.db.insert("entries", { schemaId: args.schemaId, data })
      )
    );

    return ids;
  },
});

import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("schemas")
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }
    
    return schema;
  },
});

export const update = mutation({
  args: {
    schemaId: v.id("schemas"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    const patch: Record<string, unknown> = {};

    if (args.schema !== undefined) {
      if (!args.schema.title || !args.schema.description) {
        throw new ConvexError("Schema must have 'title' and 'description' properties");
      }
      patch.schema = args.schema;
      patch.title = args.schema.title;
      patch.description = args.schema.description;
    } else {
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
    }

    await ctx.db.patch(args.schemaId, patch);
  },
});

export const create = mutation({
  args: {
    schema: v.any(),
  },
  handler: async (ctx, args) => {
    // Validate that schema has required fields
    if (!args.schema.title || !args.schema.description) {
      throw new ConvexError("Schema must have 'title' and 'description' properties");
    }
    
    const schemaId = await ctx.db.insert("schemas", {
      title: args.schema.title,
      description: args.schema.description,
      schema: args.schema,
    });
    
    return schemaId;
  },
});

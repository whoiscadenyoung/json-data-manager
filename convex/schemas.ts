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

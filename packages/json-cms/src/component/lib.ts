import { v, ConvexError } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const SCHEMA_SIZE_LIMIT = 102400; // 100 KB

const schemaValidator = schema.tables.schemas.validator.extend({
  _id: v.id("schemas"),
  _creationTime: v.number(),
});

const entryValidator = schema.tables.entries.validator.extend({
  _id: v.id("entries"),
  _creationTime: v.number(),
});

// Schema queries

export const listSchemas = query({
  args: {},
  returns: v.array(schemaValidator),
  handler: async (ctx) => {
    return await ctx.db.query("schemas").order("desc").collect();
  },
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  returns: v.union(v.null(), schemaValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.schemaId);
  },
});

// Schema mutations

export const createSchema = mutation({
  args: {
    schema: v.any(),
  },
  returns: v.id("schemas"),
  handler: async (ctx, args) => {
    if (!args.schema.title || !args.schema.description) {
      throw new ConvexError(
        "Schema must have 'title' and 'description' properties",
      );
    }

    const schemaStr = JSON.stringify(args.schema);
    if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
      throw new ConvexError("Schema exceeds the 100 KB size limit.");
    }

    const schemaId = await ctx.db.insert("schemas", {
      title: args.schema.title,
      description: args.schema.description,
      schema: args.schema,
    });

    return schemaId;
  },
});

export const updateSchema = mutation({
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
        throw new ConvexError(
          "Schema must have 'title' and 'description' properties",
        );
      }
      const schemaStr = JSON.stringify(args.schema);
      if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("Schema exceeds the 100 KB size limit.");
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

export const deleteSchema = mutation({
  args: {
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    // Delete all entries associated with this schema first
    const entries = await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    await ctx.db.delete(args.schemaId);
  },
});

// Entry queries

export const listEntries = query({
  args: { schemaId: v.id("schemas") },
  returns: v.array(entryValidator),
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    return await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .order("desc")
      .collect();
  },
});

export const getEntry = query({
  args: { entryId: v.id("entries") },
  returns: v.union(v.null(), entryValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.entryId);
  },
});

// Internal queries/mutations for use within the component

export const getSchemaInternal = internalQuery({
  args: { schemaId: v.id("schemas") },
  returns: v.union(v.null(), schemaValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.schemaId);
  },
});

export const getEntryInternal = internalQuery({
  args: { entryId: v.id("entries") },
  returns: v.union(v.null(), entryValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.entryId);
  },
});

// Entry mutations

export const createEntry = mutation({
  args: {
    schemaId: v.id("schemas"),
    data: v.any(),
  },
  returns: v.id("entries"),
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    const entryId = await ctx.db.insert("entries", {
      schemaId: args.schemaId,
      data: args.data,
    });

    return entryId;
  },
});

export const createEntriesBulk = mutation({
  args: {
    schemaId: v.id("schemas"),
    dataArray: v.array(v.any()),
  },
  returns: v.array(v.id("entries")),
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    const ids = await Promise.all(
      args.dataArray.map((data) =>
        ctx.db.insert("entries", { schemaId: args.schemaId, data }),
      ),
    );

    return ids;
  },
});

export const updateEntry = mutation({
  args: {
    entryId: v.id("entries"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    await ctx.db.patch(args.entryId, { data: args.data });
  },
});

export const deleteEntry = mutation({
  args: {
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    await ctx.db.delete(args.entryId);
  },
});

export const deleteEntriesBySchema = mutation({
  args: {
    schemaId: v.id("schemas"),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    const entries = await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    return entries.length;
  },
});

// Internal mutations for advanced use cases

export const insertEntryInternal = internalMutation({
  args: {
    schemaId: v.id("schemas"),
    data: v.any(),
  },
  returns: v.id("entries"),
  handler: async (ctx, args) => {
    const entryId = await ctx.db.insert("entries", {
      schemaId: args.schemaId,
      data: args.data,
    });

    return entryId;
  },
});

export const patchEntryInternal = internalMutation({
  args: {
    entryId: v.id("entries"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.entryId, { data: args.data });
  },
});

export const deleteEntryInternal = internalMutation({
  args: {
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.entryId);
  },
});

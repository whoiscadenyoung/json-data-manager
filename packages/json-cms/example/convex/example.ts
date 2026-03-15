import { action, mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { exposeApi } from "@caden/json-cms";
import { v } from "convex/values";
import { Auth } from "convex/server";

async function getAuthUserId(ctx: { auth: Auth }) {
  return (await ctx.auth.getUserIdentity())?.subject ?? "anonymous";
}

// Example: Using the component directly with manual auth
export const createSchema = mutation({
  args: { schema: v.any() },
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.jsonCms.lib.createSchema, {
      schema: args.schema,
    });
  },
});

export const listSchemas = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(components.jsonCms.lib.listSchemas, {});
  },
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: args.schemaId,
    });
  },
});

export const createEntry = mutation({
  args: { schemaId: v.id("schemas"), data: v.any() },
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.jsonCms.lib.createEntry, args);
  },
});

export const listEntries = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.jsonCms.lib.listEntries, args);
  },
});

// Alternative: Using the exposeApi helper for a complete authenticated API
export const {
  listSchemas: listSchemasAuth,
  getSchema: getSchemaAuth,
  createSchema: createSchemaAuth,
  updateSchema,
  deleteSchema,
  listEntries: listEntriesAuth,
  getEntry,
  createEntry: createEntryAuth,
  createEntriesBulk,
  updateEntry,
  deleteEntry,
  deleteEntriesBySchema,
} = exposeApi(components.jsonCms, {
  auth: async (ctx, operation) => {
    const userId = await getAuthUserId(ctx);
    // Allow reads for anonymous users
    if (userId === "anonymous" && operation.type === "read") {
      return userId;
    }
    // Require auth for mutations
    if (userId === "anonymous") {
      throw new Error("Unauthorized");
    }
    return userId;
  },
});

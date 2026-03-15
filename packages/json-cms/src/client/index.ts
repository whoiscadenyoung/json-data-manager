import {
  actionGeneric,
  httpActionGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  Auth,
  GenericActionCtx,
  GenericDataModel,
  HttpRouter,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";

// See the example/convex/example.ts file for how to use this component.

/**
 * For re-exporting of an API accessible from React clients.
 * This exposes the full JSON CMS API with authentication.
 *
 * Example usage:
 * ```ts
 * export const {
 *   listSchemas,
 *   getSchema,
 *   createSchema,
 *   updateSchema,
 *   deleteSchema,
 *   listEntries,
 *   getEntry,
 *   createEntry,
 *   createEntriesBulk,
 *   updateEntry,
 *   deleteEntry,
 *   deleteEntriesBySchema,
 * } = exposeApi(components.jsonCms, {
 *   auth: async (ctx, operation) => {
 *     const userId = await getAuthUserId(ctx);
 *     if (!userId) throw new Error("Unauthorized");
 *     return userId;
 *   },
 * });
 * ```
 */
export function exposeApi(
  component: ComponentApi,
  options: {
    /**
     * It's very important to authenticate any functions that users will export.
     * This function should return the authorized user's ID.
     * For read operations, you may want to allow anonymous access.
     */
    auth: (
      ctx: { auth: Auth },
      operation:
        | { type: "read"; schemaId?: string; entryId?: string }
        | { type: "create"; schemaId?: string }
        | { type: "update"; schemaId?: string; entryId?: string }
        | { type: "delete"; schemaId?: string; entryId?: string },
    ) => Promise<string>;
  },
) {
  return {
    // Schema operations
    listSchemas: queryGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "read" });
        return await ctx.runQuery(component.lib.listSchemas, {});
      },
    }),
    getSchema: queryGeneric({
      args: { schemaId: v.id("schemas") },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", schemaId: args.schemaId });
        return await ctx.runQuery(component.lib.getSchema, {
          schemaId: args.schemaId,
        });
      },
    }),
    createSchema: mutationGeneric({
      args: { schema: v.any() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create" });
        return await ctx.runMutation(component.lib.createSchema, {
          schema: args.schema,
        });
      },
    }),
    updateSchema: mutationGeneric({
      args: {
        schemaId: v.id("schemas"),
        title: v.optional(v.string()),
        description: v.optional(v.string()),
        schema: v.optional(v.any()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "update", schemaId: args.schemaId });
        return await ctx.runMutation(component.lib.updateSchema, args);
      },
    }),
    deleteSchema: mutationGeneric({
      args: { schemaId: v.id("schemas") },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "delete", schemaId: args.schemaId });
        return await ctx.runMutation(component.lib.deleteSchema, args);
      },
    }),

    // Entry operations
    listEntries: queryGeneric({
      args: { schemaId: v.id("schemas") },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", schemaId: args.schemaId });
        return await ctx.runQuery(component.lib.listEntries, {
          schemaId: args.schemaId,
        });
      },
    }),
    getEntry: queryGeneric({
      args: { entryId: v.id("entries") },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", entryId: args.entryId });
        return await ctx.runQuery(component.lib.getEntry, {
          entryId: args.entryId,
        });
      },
    }),
    createEntry: mutationGeneric({
      args: { schemaId: v.id("schemas"), data: v.any() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create", schemaId: args.schemaId });
        return await ctx.runMutation(component.lib.createEntry, args);
      },
    }),
    createEntriesBulk: mutationGeneric({
      args: { schemaId: v.id("schemas"), dataArray: v.array(v.any()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create", schemaId: args.schemaId });
        return await ctx.runMutation(component.lib.createEntriesBulk, args);
      },
    }),
    updateEntry: mutationGeneric({
      args: { entryId: v.id("entries"), data: v.any() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "update", entryId: args.entryId });
        return await ctx.runMutation(component.lib.updateEntry, args);
      },
    }),
    deleteEntry: mutationGeneric({
      args: { entryId: v.id("entries") },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "delete", entryId: args.entryId });
        return await ctx.runMutation(component.lib.deleteEntry, args);
      },
    }),
    deleteEntriesBySchema: mutationGeneric({
      args: { schemaId: v.id("schemas") },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "delete", schemaId: args.schemaId });
        return await ctx.runMutation(component.lib.deleteEntriesBySchema, args);
      },
    }),
  };
}

// Convenient types for `ctx` args, that only include the bare minimum.

// type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
// type MutationCtx = Pick<
//   GenericMutationCtx<GenericDataModel>,
//   "runQuery" | "runMutation"
// >;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

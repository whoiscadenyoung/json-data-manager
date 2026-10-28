import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import { deleteMapLayersForTarget } from "./internal/mapLayers.js";
import { clampLimit } from "./internal/schemaViews.js";
import schema from "./schema.js";

const groupValidator = schema.tables.groups.validator.extend({
  _creationTime: v.number(),
  _id: v.id("groups"),
});

// Group queries

/**
 * Lists groups — every group when `collectionId` is omitted (standalone
 * groups included), or just the groups nested in that collection. Required
 * `limit` (issue #128) bounds both branches.
 */
export const listGroups = query({
  args: { collectionId: v.optional(v.id("collections")), limit: v.number() },
  handler: async (ctx, args) => {
    const { collectionId } = args;
    if (collectionId === undefined) {
      return ctx.db.query("groups").order("desc").take(clampLimit(args.limit));
    }
    return ctx.db
      .query("groups")
      .withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
      .take(clampLimit(args.limit));
  },
  returns: v.array(groupValidator),
});

export const getGroup = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => ctx.db.get(args.groupId),
  returns: v.union(v.null(), groupValidator),
});

// Group mutations

/**
 * Creates a group, optionally nested in a collection — a group can also
 * float standalone (`collectionId` omitted).
 */
export const createGroup = mutation({
  args: {
    collectionId: v.optional(v.id("collections")),
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Group must have a name");
    }
    if (args.collectionId !== undefined) {
      const collection = await ctx.db.get(args.collectionId);
      if (!collection) {
        throw new ConvexError("Collection not found");
      }
    }
    return ctx.db.insert("groups", {
      collectionId: args.collectionId,
      description: args.description,
      name: args.name,
    });
  },
  returns: v.id("groups"),
});

export const updateGroup = mutation({
  args: {
    description: v.optional(v.string()),
    groupId: v.id("groups"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Group must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.groupId, patch);
  },
});

/**
 * Deletes a group. Its datasets are not deleted — they just become ungrouped.
 * Their collection memberships (see `schemaCollections`) are untouched.
 */
export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }

    const datasets = await ctx.db
      .query("schemas")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();

    await Promise.all([
      ...datasets.map(async (dataset) => ctx.db.patch(dataset._id, { groupId: undefined })),
      // Map layers pointing at this group go with it.
      deleteMapLayersForTarget(ctx, args.groupId),
    ]);

    await ctx.db.delete(args.groupId);
  },
});

/**
 * Sets (or clears, via `null`) a dataset's group. Group membership is
 * independent of collection memberships — this never touches the
 * `schemaCollections` join table.
 */
export const setSchemaGroup = mutation({
  args: {
    groupId: v.union(v.id("groups"), v.null()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    if (args.groupId === null) {
      await ctx.db.patch(args.schemaId, { groupId: undefined });
      return;
    }

    const group = await ctx.db.get(args.groupId);
    if (!group) {
      throw new ConvexError("Group not found");
    }
    await ctx.db.patch(args.schemaId, { groupId: args.groupId });
  },
});

/**
 * Sets (or clears, via `null`) which collection a group lives in. A group
 * lives in at most one collection (`groups.collectionId` — see schema.ts);
 * "adding" a group to a collection IS setting it here, moving it out of any
 * collection it previously lived in. The group's datasets' own
 * `schemaCollections` memberships are untouched — group membership is
 * independent of dataset membership (see setSchemaGroup). Mirrors
 * setSchemaGroup's shape for datasets.
 */
export const setGroupCollection = mutation({
  args: {
    collectionId: v.union(v.id("collections"), v.null()),
    groupId: v.id("groups"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }

    if (args.collectionId === null) {
      await ctx.db.patch(args.groupId, { collectionId: undefined });
      return;
    }

    const collection = await ctx.db.get(args.collectionId);
    if (!collection) {
      throw new ConvexError("Collection not found");
    }
    await ctx.db.patch(args.groupId, { collectionId: args.collectionId });
  },
});

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import { deleteMapLayersForCollectionTree } from "./internal/mapLayers.js";
import {
  clampLimit,
  isCatalogVisibleToViewer,
  toPublicSchemaView,
} from "./internal/schemaViews.js";
import { publicSchemaViewValidator } from "./internal/shared.js";
import schema from "./schema.js";

const collectionValidator = schema.tables.collections.validator.extend({
    _creationTime: v.number(),
    _id: v.id("collections"),
  }),
  schemaCollectionValidator = schema.tables.schemaCollections.validator.extend({
    _creationTime: v.number(),
    _id: v.id("schemaCollections"),
  });

// Collection queries

export const listCollections = query({
  args: {},
  handler: async (ctx) => ctx.db.query("collections").order("desc").collect(),
  returns: v.array(collectionValidator),
});

export const getCollection = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => ctx.db.get(args.collectionId),
  returns: v.union(v.null(), collectionValidator),
});

// Collection mutations

export const createCollection = mutation({
  args: {
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Collection must have a name");
    }
    return ctx.db.insert("collections", { description: args.description, name: args.name });
  },
  returns: v.id("collections"),
});

export const updateCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    description: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.collectionId);
    if (!existing) {
      throw new ConvexError("Collection not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Collection must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.collectionId, patch);
  },
});

/**
 * Deletes a collection along with every group inside it. Membership is
 * many-to-many (see `schemaCollections`), so member datasets simply lose
 * this one collection — their other collection memberships are untouched.
 * Datasets inside the deleted groups become ungrouped.
 */
export const deleteCollection = mutation({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.collectionId);
    if (!existing) {
      throw new ConvexError("Collection not found");
    }

    const [groups, memberships] = await Promise.all([
      ctx.db
        .query("groups")
        .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
        .collect(),
      ctx.db
        .query("schemaCollections")
        .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
        .collect(),
    ]);

    const groupedDatasets = await Promise.all(
      groups.map(async (group) =>
        ctx.db
          .query("schemas")
          .withIndex("by_group", (q) => q.eq("groupId", group._id))
          .collect(),
      ),
    );

    await Promise.all([
      ...groups.map(async (group) => ctx.db.delete(group._id)),
      ...memberships.map(async (membership) => ctx.db.delete(membership._id)),
      ...groupedDatasets
        .flat()
        .map(async (dataset) => ctx.db.patch(dataset._id, { groupId: undefined })),
      // Map layers pointing at this collection (or any of its groups, which
      // are being deleted just above) go with it.
      deleteMapLayersForCollectionTree(
        ctx,
        args.collectionId,
        groups.map((group) => group._id),
      ),
    ]);

    await ctx.db.delete(args.collectionId);
  },
});

// Dataset <-> collection/group association
//
// Collections are many-to-many (a dataset can sit in any number of them, via
// the `schemaCollections` join table — see schema.ts), while a dataset has at
// most one group. The two relationships are independent: neither mutation
// side touches the other.

/**
 * One collection's member datasets as full docs. Catalog-filtered like
 * `listSchemas` (roadmap 5a, #99): a lifecycle draft never reaches a consumer
 * enumeration payload — it appears only via `listDraftSchemaSummaries`, the
 * drafts-toggle read. This is an enumeration like `listSchemas`, not a
 * per-id read, so it carries the same viewer scoping (`viewerId`, stage 8).
 * By-id reads are scoped at the host's auth policy instead (the `getSchema`
 * per-id surface must stay openable by the creator's own client). The
 * internal full-table scans (delete cascade, `backfillDatasetSummaries`)
 * also stay unfiltered — they must see every doc; a future host flow that
 * legitimately needs a collection's drafts (5b/7b publish enumeration)
 * should get its own internal component read, not widen this consumer one.
 */
export const listSchemasByCollection = query({
  args: { collectionId: v.id("collections"), viewerId: v.string() },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
      .collect();
    const datasets = await Promise.all(memberships.map(async (row) => ctx.db.get(row.schemaId)));
    return datasets
      .filter(
        (dataset): dataset is NonNullable<typeof dataset> =>
          dataset !== null && isCatalogVisibleToViewer(dataset, args.viewerId),
      )
      .map(toPublicSchemaView);
  },
  returns: v.array(publicSchemaViewValidator),
});

/** Every `{dataset, collection}` membership row — lets clients count/filter memberships without one query per collection. Required `limit` (issue #128) bounds the scan. */
export const listSchemaCollections = query({
  args: { limit: v.number() },
  handler: async (ctx, args) =>
    ctx.db.query("schemaCollections").order("desc").take(clampLimit(args.limit)),
  returns: v.array(schemaCollectionValidator),
});

/** The collections a dataset currently belongs to. */
export const listCollectionsBySchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    const collections = await Promise.all(
      memberships.map(async (row) => ctx.db.get(row.collectionId)),
    );
    return collections.filter((collection) => collection !== null);
  },
  returns: v.array(collectionValidator),
});

/** Adds a dataset to a collection (a no-op if the membership already exists). */
export const addSchemaToCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const [dataset, collection] = await Promise.all([
      ctx.db.get(args.schemaId),
      ctx.db.get(args.collectionId),
    ]);
    if (!dataset) {
      throw new ConvexError("Schema not found");
    }
    if (!collection) {
      throw new ConvexError("Collection not found");
    }

    const existing = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    if (existing.some((row) => row.collectionId === args.collectionId)) {
      return;
    }
    await ctx.db.insert("schemaCollections", {
      collectionId: args.collectionId,
      // Denormalized for `listGeospatialSchemaIdsByCollection` (see the
      // field's doc comment in schema.ts) — read at insert time so the
      // membership row never needs the schema doc to answer "geospatial?".
      kind: dataset.kind,
      schemaId: args.schemaId,
    });
  },
});

/** Removes one of a dataset's collection memberships. Its other memberships and its group are untouched. */
export const removeSchemaFromCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    await Promise.all(
      memberships
        .filter((row) => row.collectionId === args.collectionId)
        .map(async (row) => ctx.db.delete(row._id)),
    );
  },
});

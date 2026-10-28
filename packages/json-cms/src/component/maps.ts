import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { deleteMapLayersForLayer } from "./internal/mapLayers.js";
import { clampLimit } from "./internal/schemaViews.js";
import schema from "./schema.js";

const mapValidator = schema.tables.maps.validator.extend({
    _creationTime: v.number(),
    _id: v.id("maps"),
  }),
  mapLayerValidator = schema.tables.mapLayers.validator.extend({
    _creationTime: v.number(),
    _id: v.id("mapLayers"),
  }),
  mapLayerOverrideValidator = schema.tables.mapLayerOverrides.validator.extend({
    _creationTime: v.number(),
    _id: v.id("mapLayerOverrides"),
  });

// Map queries

export const listMaps = query({
  // Required limit (issue #128) — saved maps are a small per-user table, but
  // the read is bounded like every other enumeration.
  args: { limit: v.number() },
  handler: async (ctx, args) => ctx.db.query("maps").order("desc").take(clampLimit(args.limit)),
  returns: v.array(mapValidator),
});

export const getMap = query({
  args: { mapId: v.id("maps") },
  handler: async (ctx, args) => ctx.db.get(args.mapId),
  returns: v.union(v.null(), mapValidator),
});

// Map mutations

export const createMap = mutation({
  args: {
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Map must have a name");
    }
    return ctx.db.insert("maps", { description: args.description, name: args.name });
  },
  returns: v.id("maps"),
});

export const updateMap = mutation({
  args: {
    description: v.optional(v.string()),
    mapId: v.id("maps"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.mapId);
    if (!existing) {
      throw new ConvexError("Map not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Map must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.mapId, patch);
  },
});

/** Deletes a map and every layer in it. The layers' targets are untouched. */
export const deleteMap = mutation({
  args: { mapId: v.id("maps") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.mapId);
    if (!existing) {
      throw new ConvexError("Map not found");
    }

    const layers = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", args.mapId))
      .collect();
    // deleteMapLayersForTarget deletes each layer's override rows too.
    await Promise.all(layers.map(async (layer) => deleteMapLayersForLayer(ctx, layer._id)));
    await ctx.db.delete(args.mapId);
  },
});

// Map layer queries

/**
 * Lists a map's layers in draw order (the `by_map` index covers
 * `[mapId, order]`, so an ascending index scan IS the draw order). With
 * `mapId` omitted, lists every layer across all maps — lets a client count
 * layers per map in one query instead of one query per map. Required
 * `limit` (issue #128) bounds both branches.
 */
export const listMapLayers = query({
  args: { limit: v.number(), mapId: v.optional(v.id("maps")) },
  handler: async (ctx, args) => {
    const { mapId } = args;
    if (mapId === undefined) {
      return ctx.db.query("mapLayers").order("asc").take(clampLimit(args.limit));
    }
    return ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", mapId))
      .order("asc")
      .take(clampLimit(args.limit));
  },
  returns: v.array(mapLayerValidator),
});

// Map layer mutations

const mapLayerTargetTypeValidator = v.union(
  v.literal("collection"),
  v.literal("group"),
  v.literal("dataset"),
  // A HOST-side derived dataset (roadmap 3a, #96): `targetId` is the app's
  // derivedDatasets registry id. The component cannot query host tables, so
  // this branch is validated shape-level here; existence is the host
  // wrapper's job (api.maps.addDerivedLayer checks the registry row before
  // delegating to addMapLayer). A layer whose registry row is later deleted
  // dangles by design — cascade deletes cover component targets only — and
  // host readers render it defensively ("deleted derived dataset"), the same
  // way they already answer dangling component targets.
  v.literal("derived"),
);

/** Display labels per target type, for the not-found errors. */
const TARGET_LABELS: Record<"collection" | "dataset" | "derived" | "group", string> = {
  collection: "Collection",
  dataset: "Dataset",
  derived: "Derived dataset",
  group: "Group",
};

/**
 * The "derived" branch's shape-level check (see mapLayerTargetTypeValidator):
 * the component cannot query host tables, so only the string's presence is
 * verified here — registry existence is inverted into the host wrapper
 * (api.maps.addDerivedLayer), which validates before delegating.
 */
function normalizeDerivedLayerTarget(targetId: string): string {
  if (targetId === "") {
    throw new ConvexError(`${TARGET_LABELS.derived} not found`);
  }
  return targetId;
}

/**
 * Validates that `targetId` — a plain string from the host app (see
 * exposeApi's note on id validation) — names an existing row of the table
 * `targetType` implies, returning its normalized component id. The
 * "derived" branch has no component table to check: it is shape-level only
 * and passes through (see normalizeDerivedLayerTarget).
 */
async function normalizeMapLayerTarget(
  ctx: MutationCtx,
  targetType: "collection" | "group" | "dataset" | "derived",
  targetId: string,
): Promise<string> {
  if (targetType === "derived") {
    return normalizeDerivedLayerTarget(targetId);
  }
  const label = TARGET_LABELS[targetType],
    assertFound = (doc: unknown) => {
      if (doc === null) {
        throw new ConvexError(`${label} not found`);
      }
    };
  switch (targetType) {
    case "collection": {
      const id = ctx.db.normalizeId("collections", targetId);
      if (id === null) {
        throw new ConvexError(`${label} not found`);
      }
      assertFound(await ctx.db.get(id));
      return id;
    }
    case "group": {
      const id = ctx.db.normalizeId("groups", targetId);
      if (id === null) {
        throw new ConvexError(`${label} not found`);
      }
      assertFound(await ctx.db.get(id));
      return id;
    }
    default: {
      const id = ctx.db.normalizeId("schemas", targetId);
      if (id === null) {
        throw new ConvexError(`${label} not found`);
      }
      assertFound(await ctx.db.get(id));
      return id;
    }
  }
}

/**
 * Adds a layer to the end of a map, visible by default. A no-op when this
 * exact target is already a layer of the map (same duplicate guard as
 * addSchemaToCollection).
 */
export const addMapLayer = mutation({
  args: {
    mapId: v.id("maps"),
    targetId: v.string(),
    targetType: mapLayerTargetTypeValidator,
  },
  returns: v.union(v.id("mapLayers"), v.null()),
  handler: async (ctx, args) => {
    const map = await ctx.db.get(args.mapId);
    if (!map) {
      throw new ConvexError("Map not found");
    }
    const targetId = await normalizeMapLayerTarget(ctx, args.targetType, args.targetId);

    const layers = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", args.mapId))
      .collect();
    if (
      layers.some((layer) => layer.targetType === args.targetType && layer.targetId === targetId)
    ) {
      return null;
    }

    return ctx.db.insert("mapLayers", {
      mapId: args.mapId,
      order: layers.reduce((next, layer) => Math.max(next, layer.order + 1), 0),
      targetId,
      targetType: args.targetType,
      visible: true,
    });
  },
});

export const removeMapLayer = mutation({
  args: { layerId: v.id("mapLayers") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.layerId);
    if (!existing) {
      throw new ConvexError("Layer not found");
    }
    const overrides = await ctx.db
      .query("mapLayerOverrides")
      .withIndex("by_layer", (q) => q.eq("layerId", args.layerId))
      .collect();
    await Promise.all([
      ...overrides.map(async (override) => ctx.db.delete(override._id)),
      ctx.db.delete(args.layerId),
    ]);
  },
});

export const setMapLayerVisibility = mutation({
  args: { layerId: v.id("mapLayers"), visible: v.boolean() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.layerId);
    if (!existing) {
      throw new ConvexError("Layer not found");
    }
    await ctx.db.patch(args.layerId, { visible: args.visible });
  },
});

/**
 * Every override row for one layer (only rows the user has explicitly
 * toggled exist — see the table's doc comment in schema.ts). The client
 * combines them with the layer's live children to derive effective child
 * visibility, so stale overrides (children since removed) are simply
 * ignored, not cleaned up.
 */
export const listMapLayerOverrides = query({
  args: { layerId: v.id("mapLayers") },
  handler: async (ctx, args) =>
    ctx.db
      .query("mapLayerOverrides")
      .withIndex("by_layer", (q) => q.eq("layerId", args.layerId))
      .collect(),
  returns: v.array(mapLayerOverrideValidator),
});

/** Every override row within ONE map's layers — the saved-map workspace's
 * single read for child visibility (issue #53's opportunistic scoping: the
 * old variant collected the whole `mapLayerOverrides` table across all
 * maps). Resolves the map's layers through the `by_map` index, then each
 * layer's overrides through `by_layer`, so the read stays proportional to
 * this map's own toggled children no matter how many maps exist. */
export const listMapLayerOverridesForMap = query({
  args: { mapId: v.id("maps") },
  handler: async (ctx, args) => {
    const layers = await ctx.db
        .query("mapLayers")
        .withIndex("by_map", (q) => q.eq("mapId", args.mapId))
        .collect(),
      rows = await Promise.all(
        layers.map(async (layer) =>
          ctx.db
            .query("mapLayerOverrides")
            .withIndex("by_layer", (q) => q.eq("layerId", layer._id))
            .collect(),
        ),
      );
    return rows.flat();
  },
  returns: v.array(mapLayerOverrideValidator),
});

/**
 * Sets (or clears, via `null`) a child's visibility override within one
 * layer. `childKey` is `group:<id>` or `dataset:<id>` — validated only as a
 * string here (the id inside cannot be checked against a table without
 * knowing which); the client derives keys from real children, and a stale
 * key is inert (it matches no rendered child). Clearing removes the row so
 * untouched children stay untouched.
 */
export const setMapLayerOverride = mutation({
  args: {
    childKey: v.string(),
    layerId: v.id("mapLayers"),
    visible: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const layer = await ctx.db.get(args.layerId);
    if (!layer) {
      throw new ConvexError("Layer not found");
    }

    const existing = (
        await ctx.db
          .query("mapLayerOverrides")
          .withIndex("by_layer", (q) => q.eq("layerId", args.layerId))
          .collect()
      ).filter((row) => row.childKey === args.childKey),
      // Clearing (`visible` undefined) removes any override row; setting
      // replaces any existing row for the same childKey.
      deleteExisting = Promise.all(existing.map(async (row) => ctx.db.delete(row._id)));
    if (args.visible === undefined) {
      await deleteExisting;
      return;
    }
    await deleteExisting;
    await ctx.db.insert("mapLayerOverrides", {
      childKey: args.childKey,
      layerId: args.layerId,
      visible: args.visible,
    });
  },
});

/**
 * Swaps a layer with its neighbor in draw order (`up` = toward the top of
 * the list / first drawn). A no-op when the layer is already at that end.
 */
export const moveMapLayer = mutation({
  args: {
    direction: v.union(v.literal("up"), v.literal("down")),
    layerId: v.id("mapLayers"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.layerId);
    if (!existing) {
      throw new ConvexError("Layer not found");
    }

    const layers = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", existing.mapId))
      .order("asc")
      .collect();
    const index = layers.findIndex((layer) => layer._id === args.layerId),
      neighbor = args.direction === "up" ? layers[index - 1] : layers[index + 1];
    if (neighbor === undefined || index === -1) {
      return;
    }
    await Promise.all([
      ctx.db.patch(args.layerId, { order: neighbor.order }),
      ctx.db.patch(neighbor._id, { order: existing.order }),
    ]);
  },
});

import type { Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

/** Deletes one map layer along with any child visibility overrides it carries. */
export async function deleteMapLayersForLayer(
  ctx: MutationCtx,
  layerId: Id<"mapLayers">,
): Promise<void> {
  const overrides = await ctx.db
    .query("mapLayerOverrides")
    .withIndex("by_layer", (q) => q.eq("layerId", layerId))
    .collect();
  await Promise.all([
    ...overrides.map(async (override) => ctx.db.delete(override._id)),
    ctx.db.delete(layerId),
  ]);
}

/**
 * Deletes every map layer (and its override rows) pointing at `targetId` —
 * called when a collection, group, or dataset is deleted, so no layer ever
 * dangles at a missing target.
 */
export async function deleteMapLayersForTarget(
  ctx: MutationCtx,
  targetId: Id<"collections"> | Id<"groups"> | Id<"schemas">,
): Promise<void> {
  const layers = await ctx.db
    .query("mapLayers")
    .withIndex("by_target", (q) => q.eq("targetId", targetId))
    .collect();
  await Promise.all(layers.map(async (layer) => deleteMapLayersForLayer(ctx, layer._id)));
}

/**
 * Same as {@link deleteMapLayersForTarget}, but for a whole collection tree:
 * a collection deletion takes its nested groups along (see deleteCollection),
 * so layers pointing at those groups must go too.
 */
export async function deleteMapLayersForCollectionTree(
  ctx: MutationCtx,
  collectionId: Id<"collections">,
  groupIds: Array<Id<"groups">>,
): Promise<void> {
  await Promise.all([
    deleteMapLayersForTarget(ctx, collectionId),
    ...groupIds.map(async (groupId) => deleteMapLayersForTarget(ctx, groupId)),
  ]);
}

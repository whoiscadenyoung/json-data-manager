import { exposeApi } from "@caden/json-cms";
import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { auth } from "./auth";

export const {
  listMaps: list,
  getMap: get,
  createMap: create,
  updateMap: update,
  deleteMap: remove,
  listMapLayers: listLayers,
  removeMapLayer: removeLayer,
  setMapLayerVisibility: setLayerVisibility,
  moveMapLayer: moveLayer,
  listMapLayerOverrides,
  setMapLayerOverride,
} = exposeApi(components.jsonCms, { auth });

/**
 * One component schema read that tolerates an id that isn't well-formed (the
 * projects.ts precedent — "not a dataset" is the answer that keeps the
 * layer target checks uniform over plain strings).
 */
async function tryGetSchema(
  ctx: MutationCtx,
  schemaId: string,
): Promise<FunctionReturnType<typeof components.jsonCms.lib.getSchema>> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  } catch {
    return null;
  }
}

/**
 * Appends a dataset/collection/group layer to a map — the addMapLayer
 * wrapper, made host-side for stage 8 (#104): a DATASET target is
 * visibility-checked before delegation, because layering another user's
 * draft (or author-restricted dataset) onto a shared map would otherwise
 * write their invisible row's id into shared state. Collection/group
 * targets are shared catalog organization (the recorded D1 boundary: no
 * identity dimension on them). Unknown and invisible targets get the same
 * "Dataset not found" answer.
 */
export const addLayer = mutation({
  args: {
    mapId: v.string(),
    targetId: v.string(),
    targetType: v.union(v.literal("collection"), v.literal("group"), v.literal("dataset")),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    if (args.targetType === "dataset") {
      const doc = await tryGetSchema(ctx, args.targetId);
      if (
        doc !== null &&
        (doc.lifecycle === "draft" || doc.publishedVisibility === "author") &&
        doc.createdBy !== actorId
      ) {
        throw new ConvexError("Dataset not found");
      }
    }
    return ctx.runMutation(components.jsonCms.lib.addMapLayer, {
      mapId: args.mapId,
      targetId: args.targetId,
      targetType: args.targetType,
    });
  },
  returns: v.union(v.null(), v.string()),
});

/**
 * Adds a HOST-side derived dataset as a map layer (roadmap 3a, #96; ADR
 * 0005). The component's addMapLayer accepts the "derived" target type but
 * cannot query this app's tables, so registry existence is validated HERE —
 * the inversion the component's normalizeMapLayerTarget documents — before
 * delegating. Everything else about the layer (order, visibility, the
 * duplicate guard, remove/move/visibility, delete-with-map) is component
 * state like any other layer's: only the existence check is host-side.
 * Stage 8 (#104) folds visibility into the same check: a foreign BUILDER
 * AUTOSAVE (a draft registry row) reads as absent — layering it would leak
 * its existence into a shared map; saved rows are catalog-visible.
 *
 * Readiness is deliberately NOT gated at write time — health is computed at
 * read time (derivedSpec.specStatus) and every consumer (map rendering, the
 * picker, exports) re-filters on it, so a spec that goes stale after the
 * layer was added simply renders nothing until it recovers. Deleting the
 * registry row leaves the layer dangling (cascade deletes cover component
 * targets only); readers answer "Deleted derived dataset" defensively.
 */
export const addDerivedLayer = mutation({
  args: {
    // A component `maps` id as a plain string — component tables don't exist
    // in this deployment's generated data model (the datasetBindings
    // precedent). The component's own `v.id("maps")` + existence check
    // validate it.
    mapId: v.string(),
    targetId: v.string(),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    // normalizeId first: a malformed string fails to decode, a well-formed
    // but unknown (or deleted) id reads null — the registry module's own
    // get/remove pattern.
    const id = ctx.db.normalizeId("derivedDatasets", args.targetId);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || (row.status !== "saved" && row.createdBy !== actorId)) {
      throw new ConvexError("Derived dataset not found");
    }
    return ctx.runMutation(components.jsonCms.lib.addMapLayer, {
      mapId: args.mapId,
      targetId: args.targetId,
      targetType: "derived",
    });
  },
  returns: v.union(v.null(), v.string()),
});

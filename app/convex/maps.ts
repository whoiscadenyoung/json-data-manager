import { exposeApi } from "@caden/json-cms";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { auth } from "./auth";
import { mutation } from "./_generated/server";

export const {
  listMaps: list,
  getMap: get,
  createMap: create,
  updateMap: update,
  deleteMap: remove,
  listMapLayers: listLayers,
  addMapLayer: addLayer,
  removeMapLayer: removeLayer,
  setMapLayerVisibility: setLayerVisibility,
  moveMapLayer: moveLayer,
  listMapLayerOverrides,
  setMapLayerOverride,
} = exposeApi(components.jsonCms, { auth });

/**
 * Adds a HOST-side derived dataset as a map layer (roadmap 3a, #96; ADR
 * 0005). The component's addMapLayer accepts the "derived" target type but
 * cannot query this app's tables, so registry existence is validated HERE —
 * the inversion the component's normalizeMapLayerTarget documents — before
 * delegating. Everything else about the layer (order, visibility, the
 * duplicate guard, remove/move/visibility, delete-with-map) is component
 * state like any other layer's: only the existence check is host-side.
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
    await auth(ctx);
    // normalizeId first: a malformed string fails to decode, a well-formed
    // but unknown (or deleted) id reads null — the registry module's own
    // get/remove pattern.
    const id = ctx.db.normalizeId("derivedDatasets", args.targetId);
    if (id === null || (await ctx.db.get(id)) === null) {
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

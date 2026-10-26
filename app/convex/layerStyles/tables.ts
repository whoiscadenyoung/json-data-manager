import { defineTable } from "convex/server";
import { v } from "convex/values";

import { layerStyleValidator } from "./validators";

/**
 * The layer-styles module's table, spread into `convex/schema.ts` with one
 * line so the whole feature is removable (docs/layer-styles.md "Removing
 * layer styles").
 *
 * One row per styled dataset on a map: `(mapId, renderId)` where `renderId`
 * is the id the map renders the dataset under (a component dataset id or a
 * derived-registry id — the same key `colorBySchema` uses). Both are plain
 * strings: component tables don't exist in this deployment's data model (the
 * datasetBindings precedent). A row whose map or dataset left is inert —
 * readers only ever ask for the rows of a map they are drawing, and the map
 * draws only the render ids it still has (the stale override-key rule).
 */
export const layerStyleTables = {
  layerStyles: defineTable({
    mapId: v.string(),
    renderId: v.string(),
    style: layerStyleValidator,
    /** Better Auth user id (`users.authId`) of the last writer. */
    updatedBy: v.string(),
    updatedAt: v.number(),
  }).index("by_mapId_and_renderId", ["mapId", "renderId"]),
};

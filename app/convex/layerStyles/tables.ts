import { layerStyleValidator } from "@caden/layer-styles/validators";
import { defineTable } from "convex/server";
import { v } from "convex/values";

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
  /**
   * Uploaded point-marker icons (docs/layer-styles.md "Uploaded icons"),
   * shared by every map like the styles themselves (ADR 0009). The stored
   * file is always a PNG the uploader's browser rasterized — SVG markup is
   * never stored or served. A style names an icon `user-<_id>`.
   */
  layerStyleIcons: defineTable({
    /** Display name (the file name without its extension). */
    label: v.string(),
    storageId: v.id("_storage"),
    /** A tintable single-color glyph stored as an SDF (`icon-color` applies); else full color. */
    sdf: v.boolean(),
    /** Stored image size in device pixels. */
    width: v.number(),
    height: v.number(),
    pixelRatio: v.number(),
    /** Better Auth user id (`users.authId`) of the uploader. */
    uploadedBy: v.string(),
    uploadedAt: v.number(),
  })
    .index("by_uploadedAt", ["uploadedAt"])
    .index("by_storageId", ["storageId"]),
};

import { ConvexError, v } from "convex/values";

import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { auth } from "../auth";
import { ICON_LIMITS } from "./validators";

/**
 * Uploaded point-marker icons (docs/layer-styles.md "Uploaded icons"), part
 * of the removable layer-styles module. Scoped like the styles: any
 * signed-in user can upload, list, use, and delete them (the
 * trusted-collaborator model, ADR 0009). A style that names a deleted icon
 * draws circles and the editor says so.
 *
 * The uploader's browser rasterizes the picked SVG/PNG to a small PNG (an
 * SDF when "tintable") and stores only that, so SVG markup is never stored
 * or served. `create` re-checks the stored file's type and size and the
 * declared dimensions, and deletes the file when it refuses it.
 */

const iconRowValidator = v.object({
  iconId: v.id("layerStyleIcons"),
  /** The name styles use in `icon-image`: `user-<iconId>`. */
  name: v.string(),
  label: v.string(),
  url: v.union(v.string(), v.null()),
  sdf: v.boolean(),
  width: v.number(),
  height: v.number(),
  pixelRatio: v.number(),
  uploadedBy: v.string(),
});

/** The `icon-image` name of an uploaded icon. */
export function iconName(iconId: Id<"layerStyleIcons">): string {
  return `user-${iconId}`;
}

function dimensionProblem(value: number, label: string): string | undefined {
  if (!Number.isInteger(value) || value < 1 || value > ICON_LIMITS.maxPx) {
    return `${label} must be 1 to ${ICON_LIMITS.maxPx} pixels.`;
  }
  return undefined;
}

/** A short-lived URL the browser POSTs the rasterized PNG to. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    return await ctx.storage.generateUploadUrl();
  },
  returns: v.string(),
});

const createArgs = {
  storageId: v.id("_storage"),
  label: v.string(),
  sdf: v.boolean(),
  width: v.number(),
  height: v.number(),
  pixelRatio: v.number(),
};

/** Why an upload can't become an icon, or `undefined` when it can. */
function uploadProblem(
  args: { label: string; width: number; height: number; pixelRatio: number },
  file: { contentType?: string; size: number },
  iconCount: number,
): string | undefined {
  if (file.contentType !== "image/png") {
    return "Icons are stored as PNG images.";
  }
  if (file.size > ICON_LIMITS.fileBytes) {
    return "This icon is too large (256 KB at most).";
  }
  const label = args.label.trim();
  if (label === "" || label.length > ICON_LIMITS.label) {
    return `Name the icon (up to ${ICON_LIMITS.label} characters).`;
  }
  if (args.pixelRatio !== 1 && args.pixelRatio !== 2) {
    return "Icons are stored at pixel ratio 1 or 2.";
  }
  if (iconCount >= ICON_LIMITS.count) {
    return `There are already ${ICON_LIMITS.count} uploaded icons. Delete some first.`;
  }
  return dimensionProblem(args.width, "Icon width") ?? dimensionProblem(args.height, "Icon height");
}

/**
 * Registers an uploaded PNG as a marker icon. A refused upload's file is
 * deleted and the refusal comes back as `{ ok: false, error }` rather than a
 * throw, because a throw would roll the deletion back with it.
 */
export const create = mutation({
  args: createArgs,
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      file = await ctx.db.system.get("_storage", args.storageId);
    if (file === null) {
      throw new ConvexError("The upload didn't arrive. Try again.");
    }
    const claimed = await ctx.db
      .query("layerStyleIcons")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (claimed !== null) {
      throw new ConvexError("This file is already an icon.");
    }
    const existing = await ctx.db.query("layerStyleIcons").take(ICON_LIMITS.count),
      problem = uploadProblem(args, file, existing.length);
    if (problem !== undefined) {
      await ctx.storage.delete(args.storageId);
      return { error: problem, ok: false as const };
    }
    const iconId = await ctx.db.insert("layerStyleIcons", {
      height: args.height,
      label: args.label.trim(),
      pixelRatio: args.pixelRatio,
      sdf: args.sdf,
      storageId: args.storageId,
      uploadedAt: Date.now(),
      uploadedBy: actorId,
      width: args.width,
    });
    return { iconId, name: iconName(iconId), ok: true as const };
  },
  returns: v.union(
    v.object({ ok: v.literal(true), iconId: v.id("layerStyleIcons"), name: v.string() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
});

/** Every uploaded icon, newest first (the Marker picker's "Uploaded" tab). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const rows = await ctx.db
      .query("layerStyleIcons")
      .withIndex("by_uploadedAt")
      .order("desc")
      .take(ICON_LIMITS.count);
    return await Promise.all(
      rows.map(async (row) => ({
        height: row.height,
        iconId: row._id,
        label: row.label,
        name: iconName(row._id),
        pixelRatio: row.pixelRatio,
        sdf: row.sdf,
        uploadedBy: row.uploadedBy,
        url: await ctx.storage.getUrl(row.storageId),
        width: row.width,
      })),
    );
  },
  returns: v.array(iconRowValidator),
});

/** Deletes an uploaded icon and its file; styles using it fall back to circles. */
export const remove = mutation({
  args: { iconId: v.id("layerStyleIcons") },
  handler: async (ctx, args) => {
    await auth(ctx);
    const row = await ctx.db.get("layerStyleIcons", args.iconId);
    if (row === null) {
      return null;
    }
    await ctx.db.delete("layerStyleIcons", row._id);
    await ctx.storage.delete(row.storageId);
    return null;
  },
  returns: v.null(),
});

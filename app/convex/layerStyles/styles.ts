import { ConvexError, v } from "convex/values";

import { components } from "../_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { auth } from "../auth";
import {
  ICON_NAME_PATTERN,
  layerStyleValidator,
  STYLE_LIMITS,
  type LayerStyle,
  type Marker,
  type StyleEditor,
} from "./validators";

/**
 * The layer-styles backend (docs/layer-styles.md, ADR 0012): a removable
 * module — its own table (`./tables.ts`), validators, and functions under
 * `api.layerStyles.styles.*` — that only READS the rest of the system (the
 * json-cms map and schema docs, the derived registry). Nothing else in the
 * backend imports it.
 *
 * Access model: maps are shared catalog organization under the
 * trusted-collaborator model (ADR 0009) — any signed-in user can add layers
 * to any map — so any signed-in user can style any map's datasets too. The
 * one identity rule is stage 8's: a render id written into shared state must
 * be one the writer can see (a draft or author-only dataset, or a builder
 * autosave, is the creator's alone), so styling never leaks an invisible id.
 */

/** Read bound: styles for one map (one per dataset drawn on it). */
const MAX_STYLES_PER_MAP = 500;

const styleRowValidator = v.object({
  renderId: v.string(),
  style: layerStyleValidator,
  updatedAt: v.number(),
});

async function mapExists(ctx: QueryCtx, mapId: string): Promise<boolean> {
  try {
    return (await ctx.runQuery(components.jsonCms.lib.getMap, { mapId })) !== null;
  } catch {
    // Not a well-formed component map id.
    return false;
  }
}

/** Stage 8's visibility rule for one component dataset id (the appBuilder/apps.ts helper). */
async function datasetVisibleTo(ctx: MutationCtx, schemaId: string, actorId: string) {
  let doc;
  try {
    doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  } catch {
    return false;
  }
  if (doc === null) {
    return false;
  }
  if (doc.lifecycle === "draft" || doc.publishedVisibility === "author") {
    return doc.createdBy === actorId;
  }
  return true;
}

/** A derived-registry render id: saved rows are catalog-visible; a builder autosave is its creator's alone. */
async function derivedVisibleTo(ctx: MutationCtx, renderId: string, actorId: string) {
  const id = ctx.db.normalizeId("derivedDatasets", renderId),
    row = id === null ? null : await ctx.db.get("derivedDatasets", id);
  return row !== null && (row.status === "saved" || row.createdBy === actorId);
}

async function assertWritable(ctx: MutationCtx, mapId: string, renderId: string) {
  const actorId = await auth(ctx);
  if (!(await mapExists(ctx, mapId))) {
    throw new ConvexError("Map not found.");
  }
  const visible =
    (await derivedVisibleTo(ctx, renderId, actorId)) ||
    (await datasetVisibleTo(ctx, renderId, actorId));
  if (!visible) {
    throw new ConvexError("Dataset not found.");
  }
  return actorId;
}

function assertRange(value: number, min: number, max: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConvexError(`${label} must be between ${min} and ${max}.`);
  }
}

function assertField(field: string) {
  if (field.trim() === "" || field.length > STYLE_LIMITS.field) {
    throw new ConvexError("Pick a field for the style.");
  }
}

function assertZoomRange(minzoom: number | undefined, maxzoom: number | undefined) {
  if (minzoom !== undefined) {
    assertRange(minzoom, 0, 24, "Minimum zoom");
  }
  if (maxzoom !== undefined) {
    assertRange(maxzoom, 0, 24, "Maximum zoom");
  }
  if (minzoom !== undefined && maxzoom !== undefined && minzoom >= maxzoom) {
    throw new ConvexError("Minimum zoom must be below maximum zoom.");
  }
}

function assertIconName(name: string) {
  if (name.length > STYLE_LIMITS.icon || !ICON_NAME_PATTERN.test(name)) {
    throw new ConvexError(`"${name}" isn't an icon name this app knows.`);
  }
}

function assertMarker(marker: Marker) {
  if (marker.kind !== "circle") {
    assertIconName(marker.icon);
  }
  assertRange(marker.size, 4, 96, "Marker size");
  assertRange(marker.rotation, -360, 360, "Marker rotation");
  if (marker.sizeScale !== undefined) {
    assertRange(marker.sizeScale, 1, 5, "Largest class size");
  }
}

function assertRenderer(renderer: StyleEditor["renderer"]) {
  if (renderer.kind === "categorical") {
    assertField(renderer.field);
    if (renderer.categories.length > STYLE_LIMITS.categories) {
      throw new ConvexError(`Keep categories to ${STYLE_LIMITS.categories} or fewer.`);
    }
    for (const category of renderer.categories) {
      if (category.icon !== undefined) {
        assertIconName(category.icon);
      }
    }
  } else if (renderer.kind === "graduated") {
    assertField(renderer.field);
    const { breaks, colors } = renderer;
    if (breaks.length > STYLE_LIMITS.breaks || colors.length !== breaks.length + 1) {
      throw new ConvexError("A graduated style needs one more color than class breaks.");
    }
    for (let index = 1; index < breaks.length; index += 1) {
      if (!(breaks[index - 1] < breaks[index])) {
        throw new ConvexError("Class breaks must increase.");
      }
    }
  }
}

function assertEditor(editor: StyleEditor) {
  assertRenderer(editor.renderer);
  assertRange(editor.opacity, 0, 1, "Opacity");
  assertRange(editor.strokeWidth, 0, 20, "Outline width");
  assertRange(editor.lineWidth, 0, 20, "Line width");
  assertRange(editor.radius, 0, 50, "Point size");
  if (editor.marker !== undefined) {
    assertMarker(editor.marker);
  }
  if (editor.label !== undefined) {
    assertField(editor.label.field);
    assertRange(editor.label.size, 6, 48, "Label size");
  }
  assertZoomRange(editor.minzoom, editor.maxzoom);
}

/**
 * The structural checks the backend owns. Full MapLibre style-spec
 * validation (expression typing, property names) runs in the editor before
 * a save (`features/layer-styles/lib/validate.ts`) — a renderer never trusts
 * stored JSON blindly either: MapLibre rejects a bad layer at add time and
 * the map draws the rest.
 */
export function assertStyle(style: LayerStyle) {
  if (style.layers.length === 0 || style.layers.length > STYLE_LIMITS.layers) {
    throw new ConvexError(`A style holds 1 to ${STYLE_LIMITS.layers} layers.`);
  }
  if (JSON.stringify(style).length > STYLE_LIMITS.jsonChars) {
    throw new ConvexError("This style is too large to save.");
  }
  for (const layer of style.layers) {
    assertZoomRange(layer.minzoom, layer.maxzoom);
  }
  if (style.editor !== undefined) {
    assertEditor(style.editor);
  }
}

/** Every saved style for one map's datasets (signed-in users; maps are shared catalog organization). */
export const listForMap = query({
  args: { mapId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const rows = await ctx.db
      .query("layerStyles")
      .withIndex("by_mapId_and_renderId", (q) => q.eq("mapId", args.mapId))
      .take(MAX_STYLES_PER_MAP);
    return rows.map((row) => ({
      renderId: row.renderId,
      style: row.style,
      updatedAt: row.updatedAt,
    }));
  },
  returns: v.array(styleRowValidator),
});

/** Saves (inserts or replaces) one dataset's style on one map. */
export const set = mutation({
  args: { mapId: v.string(), renderId: v.string(), style: layerStyleValidator },
  handler: async (ctx, args) => {
    const actorId = await assertWritable(ctx, args.mapId, args.renderId);
    assertStyle(args.style);
    const existing = await ctx.db
        .query("layerStyles")
        .withIndex("by_mapId_and_renderId", (q) =>
          q.eq("mapId", args.mapId).eq("renderId", args.renderId),
        )
        .unique(),
      fields = { style: args.style, updatedAt: Date.now(), updatedBy: actorId };
    if (existing === null) {
      await ctx.db.insert("layerStyles", {
        mapId: args.mapId,
        renderId: args.renderId,
        ...fields,
      });
    } else {
      await ctx.db.patch("layerStyles", existing._id, fields);
    }
    return null;
  },
  returns: v.null(),
});

/** Drops one dataset's style on one map — it draws in the map's default color again. */
export const reset = mutation({
  args: { mapId: v.string(), renderId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const existing = await ctx.db
      .query("layerStyles")
      .withIndex("by_mapId_and_renderId", (q) =>
        q.eq("mapId", args.mapId).eq("renderId", args.renderId),
      )
      .unique();
    if (existing !== null) {
      await ctx.db.delete("layerStyles", existing._id);
    }
    return null;
  },
  returns: v.null(),
});

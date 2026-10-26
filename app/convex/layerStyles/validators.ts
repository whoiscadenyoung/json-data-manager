import { v, type Infer } from "convex/values";

/**
 * Every stored shape of the layer-styles module (docs/layer-styles.md, ADR
 * 0012), shared with the client so the editor builds exactly what the
 * backend accepts.
 *
 * A style IS MapLibre style-spec JSON: `layers` holds MapLibre layer
 * fragments (`type`, `paint`, `layout`, `filter`, `minzoom`, `maxzoom`) — the
 * same objects GeoLibre, Maputnik, and any MapLibre/Mapbox app read — minus
 * the `id`/`source`/`source-layer` wiring the renderer supplies per map.
 * `editor` optionally remembers the simple editor's settings so the panel can
 * reopen them; a hand-edited (Advanced JSON) style carries no `editor`.
 */

/** Size bounds — a style is a small config document, never data. */
export const STYLE_LIMITS = {
  /** MapLibre layer fragments per style (fill + line + circle + symbol, with headroom for hand-written styles). */
  layers: 8,
  /** Classes in a categories style ("Other" excluded). */
  categories: 50,
  /** Class breaks in a graduated style. */
  breaks: 10,
  /** Serialized style JSON, in characters. */
  jsonChars: 32_000,
  /** Field-name length. */
  field: 200,
} as const;

export const STYLE_LAYER_TYPES = ["fill", "line", "circle", "symbol"] as const;

export const styleLayerValidator = v.object({
  type: v.union(v.literal("fill"), v.literal("line"), v.literal("circle"), v.literal("symbol")),
  /** MapLibre paint properties (values may be expressions). */
  paint: v.optional(v.record(v.string(), v.any())),
  /** MapLibre layout properties (values may be expressions). */
  layout: v.optional(v.record(v.string(), v.any())),
  /** A MapLibre filter expression. */
  filter: v.optional(v.any()),
  minzoom: v.optional(v.number()),
  maxzoom: v.optional(v.number()),
});

const categoryValueValidator = v.union(v.string(), v.number(), v.boolean());

const singleRendererValidator = v.object({
  kind: v.literal("single"),
  color: v.string(),
});

const categoricalRendererValidator = v.object({
  kind: v.literal("categorical"),
  field: v.string(),
  categories: v.array(
    v.object({
      value: categoryValueValidator,
      color: v.string(),
    }),
  ),
  /** Color for values outside `categories` (and missing values). */
  otherColor: v.string(),
});

const graduatedRendererValidator = v.object({
  kind: v.literal("graduated"),
  field: v.string(),
  method: v.union(v.literal("equal"), v.literal("quantile")),
  /** Name of the color ramp the colors came from (for the editor's picker). */
  ramp: v.string(),
  /** Ascending upper-class thresholds: class i covers values < breaks[i]; the last color covers the rest. */
  breaks: v.array(v.number()),
  /** `breaks.length + 1` colors, lowest class first. */
  colors: v.array(v.string()),
});

export const rendererValidator = v.union(
  singleRendererValidator,
  categoricalRendererValidator,
  graduatedRendererValidator,
);

export const labelValidator = v.object({
  field: v.string(),
  size: v.number(),
  color: v.string(),
  haloColor: v.string(),
});

/** The simple editor's settings — what the Style panel edits; `layers` is compiled from it. */
export const styleEditorValidator = v.object({
  renderer: rendererValidator,
  /** Fill opacity for polygons (0–1). */
  opacity: v.number(),
  /** Polygon outline color. */
  strokeColor: v.string(),
  /** Polygon outline width in pixels. */
  strokeWidth: v.number(),
  /** Line-feature width in pixels. */
  lineWidth: v.number(),
  /** Point radius in pixels. */
  radius: v.number(),
  label: v.optional(labelValidator),
  minzoom: v.optional(v.number()),
  maxzoom: v.optional(v.number()),
});

export const layerStyleValidator = v.object({
  version: v.literal(1),
  layers: v.array(styleLayerValidator),
  editor: v.optional(styleEditorValidator),
});

export type StyleLayer = Infer<typeof styleLayerValidator>;
export type StyleLayerType = StyleLayer["type"];
export type Renderer = Infer<typeof rendererValidator>;
export type StyleLabel = Infer<typeof labelValidator>;
export type StyleEditor = Infer<typeof styleEditorValidator>;
export type LayerStyle = Infer<typeof layerStyleValidator>;

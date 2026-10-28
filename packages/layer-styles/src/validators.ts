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
  /** Icon-name length (`user-<convex id>` is the longest form). */
  icon: 80,
} as const;

/**
 * Point marker icons are sprite image names, namespaced by family: the
 * built-in sprite's `shape-*`, `lucide-*`, `maki-*`, and uploads' `user-<id>`
 * (docs/layer-styles.md "Point markers").
 */
export const ICON_NAME_PATTERN = /^(shape|lucide|maki|user)-[a-z0-9-]+$/;

/** Bounds on uploaded marker icons (docs/layer-styles.md "Uploaded icons"). */
export const ICON_LIMITS = {
  /** The file a person picks (SVG or PNG), and the PNG stored after rasterizing. */
  fileBytes: 256 * 1024,
  /** Stored image width/height in device pixels (and a PNG's accepted input size). */
  maxPx: 128,
  /** Uploaded icons across the deployment (the picker lists them all). */
  count: 500,
  /** Display-name length. */
  label: 80,
} as const;

export const MARKER_KINDS = ["circle", "shape", "icon"] as const;

/**
 * How points draw. `circle` is a MapLibre `circle` layer (`StyleEditor.radius`
 * sizes it); `shape` and `icon` compile to a `symbol` layer whose
 * `icon-image` is `icon` (or, in a categories style, a per-category icon).
 */
export const markerValidator = v.object({
  kind: v.union(v.literal("circle"), v.literal("shape"), v.literal("icon")),
  /** Sprite image name for shape/icon markers (the default for every class). */
  icon: v.string(),
  /** Glyph size in pixels for shape/icon markers. */
  size: v.number(),
  /** Clockwise rotation in degrees (shape/icon). */
  rotation: v.number(),
  /** Draw every marker even when they overlap (shape/icon; circles always do). */
  allowOverlap: v.boolean(),
  /** Graduated only: the largest class draws this many times the base size, classes in between scale evenly. */
  sizeScale: v.optional(v.number()),
});

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
      /** This class's marker icon when points draw as shapes/icons (else the marker's own icon). */
      icon: v.optional(v.string()),
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
  /** How points draw; absent = circles (the original look). */
  marker: v.optional(markerValidator),
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
export type Marker = Infer<typeof markerValidator>;
export type MarkerKind = Marker["kind"];
export type StyleEditor = Infer<typeof styleEditorValidator>;
export type LayerStyle = Infer<typeof layerStyleValidator>;

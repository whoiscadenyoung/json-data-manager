import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import {
  STYLE_LAYER_TYPES,
  STYLE_LIMITS,
  type LayerStyle,
  type StyleLayer,
  type StyleLayerType,
} from "#convex/layerStyles/validators";

/**
 * Moving styles in and out as MapLibre style-spec JSON (the transferability
 * contract in docs/layer-styles.md): validation against the real style spec,
 * export to complete MapLibre layers, and import from whatever a MapLibre
 * tool hands over — one layer, an array of layers, or a whole style.json.
 */

/** The placeholder source exported layers point at; rename it to your own GeoJSON/vector source. */
export const EXPORT_SOURCE_ID = "dataset";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLayerType(value: unknown): value is StyleLayerType {
  return STYLE_LAYER_TYPES.some((type) => type === value);
}

/** Converts a style's fragments into complete MapLibre layer objects with ids and a source. */
export function toMapLibreLayers(
  layers: readonly StyleLayer[],
  options: { idPrefix: string; source: string },
): Array<Record<string, unknown>> {
  return layers.map((layer, index) => ({
    id: `${options.idPrefix}-${layer.type}-${index + 1}`,
    source: options.source,
    ...layer,
  }));
}

/** A slug for exported layer ids. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" ? "layer" : slug;
}

/**
 * MapLibre style-spec errors for a set of fragments (empty = valid). The
 * fragments are wrapped in a minimal style (one GeoJSON source, a glyphs URL
 * so symbol layers validate) and checked by the same validator MapLibre runs.
 */
export function validateLayers(layers: readonly StyleLayer[]): string[] {
  const style = {
    glyphs: "https://example.invalid/{fontstack}/{range}.pbf",
    layers: toMapLibreLayers(layers, { idPrefix: "layer", source: EXPORT_SOURCE_ID }),
    sources: {
      [EXPORT_SOURCE_ID]: { data: { features: [], type: "FeatureCollection" }, type: "geojson" },
    },
    version: 8,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validateStyleMin validates arbitrary JSON; the spec type is what it checks for.
  const errors = validateStyleMin(style as unknown as Parameters<typeof validateStyleMin>[0]);
  return errors.map((error) => error.message);
}

/** The fragment a MapLibre layer object contributes (wiring fields dropped), or an error. */
function fragmentOf(raw: unknown, index: number): StyleLayer | string {
  if (!isRecord(raw)) {
    return `Layer ${index + 1} is not an object.`;
  }
  if (!isLayerType(raw["type"])) {
    return `Layer ${index + 1} has type "${String(raw["type"])}" — styles support fill, line, circle, and symbol layers.`;
  }
  const fragment: StyleLayer = { type: raw["type"] };
  if (isRecord(raw["paint"])) {
    fragment.paint = raw["paint"];
  }
  if (isRecord(raw["layout"])) {
    fragment.layout = raw["layout"];
  }
  if (raw["filter"] !== undefined) {
    fragment.filter = raw["filter"];
  }
  if (typeof raw["minzoom"] === "number") {
    fragment.minzoom = raw["minzoom"];
  }
  if (typeof raw["maxzoom"] === "number") {
    fragment.maxzoom = raw["maxzoom"];
  }
  return fragment;
}

function layerListOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed["layers"])) {
    return parsed["layers"];
  }
  return [parsed];
}

export type ImportResult = { ok: true; style: LayerStyle } | { ok: false; errors: string[] };

/**
 * Parses pasted MapLibre JSON — one layer object, an array of layers, or a
 * full style.json (its `layers` are taken; sources, ids, and `source-layer`
 * are ignored because this app wires them per map) — into a custom style.
 */
export function importStyleJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ["That isn't valid JSON."], ok: false };
  }
  const raws = layerListOf(parsed),
    fragments = raws.map((raw, index) => fragmentOf(raw, index)),
    problems = fragments.filter((fragment) => typeof fragment === "string"),
    layers = fragments.filter((fragment) => typeof fragment !== "string");
  if (problems.length > 0) {
    return { errors: problems, ok: false };
  }
  if (layers.length === 0 || layers.length > STYLE_LIMITS.layers) {
    return { errors: [`A style holds 1 to ${STYLE_LIMITS.layers} layers.`], ok: false };
  }
  const errors = validateLayers(layers);
  if (errors.length > 0) {
    return { errors, ok: false };
  }
  const style: LayerStyle = { layers, version: 1 };
  if (JSON.stringify(style).length > STYLE_LIMITS.jsonChars) {
    return { errors: ["This style is too large to save."], ok: false };
  }
  return { ok: true, style };
}

/** Pretty-printed MapLibre layers for the Advanced view, copy, and download. */
export function exportStyleJson(style: LayerStyle, title: string): string {
  return JSON.stringify(
    toMapLibreLayers(style.layers, { idPrefix: slugify(title), source: EXPORT_SOURCE_ID }),
    null,
    2,
  );
}

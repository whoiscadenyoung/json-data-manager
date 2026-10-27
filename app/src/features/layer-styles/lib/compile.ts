import type {
  LayerStyle,
  Marker,
  Renderer,
  StyleEditor,
  StyleLayer,
} from "#convex/layerStyles/validators";

import { NO_DATA_COLOR } from "./palettes";

/**
 * Compiles the simple editor's settings into MapLibre style-spec layer
 * fragments — the stored, rendered, and exported form of a style. Each
 * fragment carries its own geometry-type filter, so the exported JSON draws
 * correctly in any MapLibre app pointed at a mixed GeoJSON source.
 */

/** A MapLibre expression (JSON array) or literal value. */
type Expression = unknown;

/** The basemap's own label font stack — the only glyphs its glyph server is guaranteed to serve. */
export const LABEL_FONT = [
  "Montserrat Regular",
  "Open Sans Regular",
  "Noto Sans Regular",
  "HanWangHeiLight Regular",
  "NanumBarunGothic Regular",
];

/**
 * Glyph size in pixels at `icon-size: 1` — the layer-styles sprite's glyph
 * box (`sprite/build.ts` `GLYPH_PX`) and the size uploads are normalized to.
 */
export const ICON_GLYPH_PX = 24;

/** Where a fresh Shape / Icon marker starts (Lucide is the default icon family). */
export const DEFAULT_MARKER_ICON = { icon: "lucide-map-pin", shape: "shape-square" } as const;

const POLYGONS: Expression = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const LINES: Expression = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];
const POINTS: Expression = ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]];

/**
 * The renderer's color as a MapLibre expression over `["get", field]`.
 * Categories match on `to-string` so numbers, strings, and booleans all
 * compare the way the editor keyed them (`classify.distinctValues`).
 */
export function colorExpression(renderer: Renderer): Expression {
  if (renderer.kind === "single") {
    return renderer.color;
  }
  const value = ["get", renderer.field];
  if (renderer.kind === "categorical") {
    const seen = new Set<string>(),
      arms: string[] = [];
    for (const category of renderer.categories) {
      const key = String(category.value);
      if (!seen.has(key)) {
        seen.add(key);
        arms.push(key, category.color);
      }
    }
    if (arms.length === 0) {
      return renderer.otherColor;
    }
    return ["match", ["to-string", value], ...arms, renderer.otherColor];
  }
  const { breaks, colors } = renderer,
    stops = breaks.flatMap((threshold, index) => [threshold, colors[index + 1]]);
  return [
    "case",
    ["==", value, null],
    NO_DATA_COLOR,
    stops.length === 0 ? colors[0] : ["step", ["to-number", value, 0], colors[0], ...stops],
  ];
}

/**
 * A point size as an expression: `base`, or — for a graduated style whose
 * marker grows by class — a `step` from `base` up to `base * sizeScale`
 * (features with no value keep `base`).
 */
export function sizeExpression(renderer: Renderer, base: number, marker: Marker | undefined) {
  const scale = marker === undefined ? undefined : marker.sizeScale;
  if (renderer.kind !== "graduated" || scale === undefined || renderer.breaks.length === 0) {
    return base;
  }
  const { breaks } = renderer,
    sizeAt = (index: number) =>
      Math.round(base * (1 + ((scale - 1) * index) / breaks.length) * 1000) / 1000,
    stops = breaks.flatMap((threshold, index) => [threshold, sizeAt(index + 1)]),
    value = ["get", renderer.field];
  return [
    "case",
    ["==", value, null],
    base,
    ["step", ["to-number", value, 0], sizeAt(0), ...stops],
  ];
}

/** The class sizes `sizeExpression` steps through (for the legend and editor preview), lowest class first. */
export function classSizeFactors(renderer: Renderer, marker: Marker | undefined): number[] {
  if (renderer.kind !== "graduated" || marker === undefined || marker.sizeScale === undefined) {
    return [];
  }
  const { breaks } = renderer,
    scale = marker.sizeScale;
  return renderer.colors.map((_, index) =>
    breaks.length === 0 ? 1 : 1 + ((scale - 1) * index) / breaks.length,
  );
}

/** Whether points draw as sprite images (a `symbol` layer) rather than MapLibre circles. */
export function usesIcons(marker: Marker | undefined): marker is Marker {
  return marker !== undefined && marker.kind !== "circle";
}

/**
 * The marker's `icon-image`: its icon, or — when a categories style gives
 * classes their own icons — a `match` on the same `to-string` key the colors
 * use, falling back to the marker's icon.
 */
export function iconExpression(renderer: Renderer, marker: Marker): Expression {
  if (renderer.kind !== "categorical") {
    return marker.icon;
  }
  const seen = new Set<string>(),
    arms: string[] = [];
  for (const category of renderer.categories) {
    const key = String(category.value);
    if (!seen.has(key)) {
      seen.add(key);
      if (category.icon !== undefined && category.icon !== marker.icon) {
        arms.push(key, category.icon);
      }
    }
  }
  if (arms.length === 0) {
    return marker.icon;
  }
  return ["match", ["to-string", ["get", renderer.field]], ...arms, marker.icon];
}

function pointLayer(editor: StyleEditor, color: Expression): StyleLayer {
  const { marker, renderer } = editor;
  if (!usesIcons(marker)) {
    return {
      filter: POINTS,
      paint: {
        "circle-color": color,
        "circle-radius": sizeExpression(renderer, editor.radius, marker),
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
      type: "circle",
    };
  }
  return {
    filter: POINTS,
    layout: {
      "icon-image": iconExpression(renderer, marker),
      "icon-size": sizeExpression(renderer, marker.size / ICON_GLYPH_PX, marker),
      ...(marker.rotation === 0 ? {} : { "icon-rotate": marker.rotation }),
      ...(marker.icon === "shape-pin" ? { "icon-anchor": "bottom" } : {}),
      "icon-allow-overlap": marker.allowOverlap,
      "icon-ignore-placement": marker.allowOverlap,
    },
    paint: {
      "icon-color": color,
      "icon-halo-color": "#ffffff",
      "icon-halo-width": 1,
    },
    type: "symbol",
  };
}

function withZoom(layer: StyleLayer, editor: StyleEditor): StyleLayer {
  return {
    ...layer,
    ...(editor.minzoom !== undefined ? { minzoom: editor.minzoom } : {}),
    ...(editor.maxzoom !== undefined ? { maxzoom: editor.maxzoom } : {}),
  };
}

function labelLayer(editor: StyleEditor): StyleLayer[] {
  const { label } = editor;
  if (label === undefined) {
    return [];
  }
  return [
    {
      layout: {
        "text-field": ["to-string", ["get", label.field]],
        "text-font": LABEL_FONT,
        "text-size": label.size,
        "text-offset": [0, 0.9],
        "text-anchor": "top",
        "text-max-width": 10,
      },
      paint: {
        "text-color": label.color,
        "text-halo-color": label.haloColor,
        "text-halo-width": 1.5,
      },
      type: "symbol",
    },
  ];
}

/** The style document for a set of simple-editor settings. */
export function compileStyle(editor: StyleEditor): LayerStyle {
  const color = colorExpression(editor.renderer),
    layers: StyleLayer[] = [
      {
        filter: POLYGONS,
        paint: { "fill-color": color, "fill-opacity": editor.opacity },
        type: "fill",
      },
      {
        filter: POLYGONS,
        paint: { "line-color": editor.strokeColor, "line-width": editor.strokeWidth },
        type: "line",
      },
      {
        filter: LINES,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": color, "line-width": editor.lineWidth },
        type: "line",
      },
      pointLayer(editor, color),
      ...labelLayer(editor),
    ];
  return { editor, layers: layers.map((layer) => withZoom(layer, editor)), version: 1 };
}

/**
 * The settings that reproduce a dataset's unstyled look (layers-map.tsx's
 * default paints: 20% fill, 2px outline in the dataset color, 5px points) —
 * where a fresh Style panel starts, so opening it changes nothing.
 */
export function defaultEditor(color: string): StyleEditor {
  return {
    lineWidth: 2,
    opacity: 0.2,
    radius: 5,
    renderer: { color, kind: "single" },
    strokeColor: color,
    strokeWidth: 2,
  };
}

import type { LayerStyle, Renderer, StyleEditor, StyleLayer } from "#convex/layerStyles/validators";

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
      {
        filter: POINTS,
        paint: {
          "circle-color": color,
          "circle-radius": editor.radius,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
        type: "circle",
      },
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

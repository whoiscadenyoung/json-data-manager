import type { LayerStyle } from "#convex/layerStyles/validators";

import { NO_DATA_COLOR } from "./palettes";

/** One legend row: a swatch and what it stands for. */
export interface LegendClass {
  color: string;
  label: string;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * The classes a style's legend shows, or `undefined` for a single-symbol or
 * hand-written style (the map keeps its one-swatch-per-dataset row for those
 * — a custom MapLibre style has no classes the editor can name).
 */
export function legendClasses(style: LayerStyle): LegendClass[] | undefined {
  const { editor } = style;
  if (editor === undefined) {
    return undefined;
  }
  const { renderer } = editor;
  if (renderer.kind === "categorical") {
    return [
      ...renderer.categories.map((category) => ({
        color: category.color,
        label: String(category.value),
      })),
      { color: renderer.otherColor, label: "Other" },
    ];
  }
  if (renderer.kind === "graduated") {
    const { breaks, colors } = renderer;
    if (breaks.length === 0) {
      return [
        { color: colors[0], label: `All ${renderer.field}` },
        { color: NO_DATA_COLOR, label: "No data" },
      ];
    }
    return [
      ...colors.map((color, index) => {
        if (index === 0) {
          return { color, label: `< ${formatNumber(breaks[0])}` };
        }
        if (index === breaks.length) {
          return { color, label: `≥ ${formatNumber(breaks[index - 1])}` };
        }
        return {
          color,
          label: `${formatNumber(breaks[index - 1])} – ${formatNumber(breaks[index])}`,
        };
      }),
      { color: NO_DATA_COLOR, label: "No data" },
    ];
  }
  return undefined;
}

/**
 * The single swatch color for a style's legend row and layer-panel dot: the
 * single-symbol color, else undefined (classed styles show their classes;
 * custom styles keep the map's assigned color).
 */
export function swatchColor(style: LayerStyle): string | undefined {
  const { editor } = style;
  return editor !== undefined && editor.renderer.kind === "single"
    ? editor.renderer.color
    : undefined;
}

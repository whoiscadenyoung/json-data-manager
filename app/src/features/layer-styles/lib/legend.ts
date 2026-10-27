import type { LayerStyle } from "#convex/layerStyles/validators";

import { usesIcons } from "./compile";
import { NO_DATA_COLOR } from "./palettes";

/** One legend row: a swatch (or the class's marker icon, tinted) and what it stands for. */
export interface LegendClass {
  color: string;
  label: string;
  /** The class's point marker icon, when points draw as shapes/icons. */
  icon?: string;
}

function withIcon(item: { color: string; label: string }, icon: string | undefined): LegendClass {
  return icon === undefined ? item : { ...item, icon };
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
  const { renderer, marker } = editor,
    baseIcon = usesIcons(marker) ? marker.icon : undefined;
  if (renderer.kind === "categorical") {
    return [
      ...renderer.categories.map((category) =>
        withIcon(
          { color: category.color, label: String(category.value) },
          baseIcon === undefined ? undefined : (category.icon ?? baseIcon),
        ),
      ),
      withIcon({ color: renderer.otherColor, label: "Other" }, baseIcon),
    ];
  }
  if (renderer.kind === "graduated") {
    const { breaks, colors } = renderer;
    if (breaks.length === 0) {
      return [
        withIcon({ color: colors[0], label: `All ${renderer.field}` }, baseIcon),
        withIcon({ color: NO_DATA_COLOR, label: "No data" }, baseIcon),
      ];
    }
    return [
      ...colors.map((color, index) => {
        if (index === 0) {
          return withIcon({ color, label: `< ${formatNumber(breaks[0])}` }, baseIcon);
        }
        if (index === breaks.length) {
          return withIcon({ color, label: `≥ ${formatNumber(breaks[index - 1])}` }, baseIcon);
        }
        return withIcon(
          { color, label: `${formatNumber(breaks[index - 1])} – ${formatNumber(breaks[index])}` },
          baseIcon,
        );
      }),
      withIcon({ color: NO_DATA_COLOR, label: "No data" }, baseIcon),
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

/**
 * A single-symbol style's point marker icon (shape/icon markers), for the
 * dataset's one legend row; `undefined` keeps the plain dot.
 */
export function singleMarkerIcon(style: LayerStyle): string | undefined {
  const { editor } = style;
  if (editor === undefined || editor.renderer.kind !== "single" || !usesIcons(editor.marker)) {
    return undefined;
  }
  return editor.marker.icon;
}

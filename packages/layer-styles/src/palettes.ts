/**
 * Color palettes for the simple style editor: one qualitative palette for
 * categories, and sequential/diverging ramps for graduated classes. Ramps
 * are anchor stops (ColorBrewer-derived) interpolated to any class count, so
 * a 3-class and a 7-class map from the same ramp read as one family.
 */

/** Qualitative colors for category classes (Tableau 10, then softer tints). */
export const CATEGORY_PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
  "#a0cbe8",
  "#ffbe7d",
] as const;

/** Values outside the listed categories, and missing values. */
export const OTHER_COLOR = "#bab0ac";

/** Features with no value in a graduated style's field. */
export const NO_DATA_COLOR = "#9ca3af";

export const COLOR_RAMPS = {
  blues: ["#eff3ff", "#6baed6", "#08306b"],
  greens: ["#edf8e9", "#74c476", "#00441b"],
  oranges: ["#feedde", "#fd8d3c", "#7f2704"],
  purples: ["#f2f0f7", "#9e9ac8", "#3f007d"],
  reds: ["#fee5d9", "#fb6a4a", "#67000d"],
  "yellow-red": ["#ffffb2", "#fd8d3c", "#bd0026"],
  viridis: ["#fde725", "#21918c", "#440154"],
  "red-blue": ["#b2182b", "#f7f7f7", "#2166ac"],
} as const;

export type RampName = keyof typeof COLOR_RAMPS;

export const RAMP_NAMES: readonly RampName[] = [
  "blues",
  "greens",
  "oranges",
  "purples",
  "reds",
  "yellow-red",
  "viridis",
  "red-blue",
];

export function isRampName(name: string): name is RampName {
  return Object.hasOwn(COLOR_RAMPS, name);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  // oxlint-disable-next-line no-bitwise -- unpacking a 24-bit RGB integer.
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The color at position `t` (0–1) along a list of anchor stops. */
function interpolateStops(stops: readonly string[], t: number): string {
  const scaled = t * (stops.length - 1),
    lower = Math.min(Math.floor(scaled), stops.length - 2),
    local = scaled - lower,
    from = hexToRgb(stops[lower]),
    to = hexToRgb(stops[lower + 1]);
  return rgbToHex([
    from[0] + (to[0] - from[0]) * local,
    from[1] + (to[1] - from[1]) * local,
    from[2] + (to[2] - from[2]) * local,
  ]);
}

/** `count` evenly spaced colors from a ramp, lightest (lowest values) first. */
export function rampColors(name: RampName, count: number): string[] {
  const stops = COLOR_RAMPS[name];
  if (count <= 1) {
    return [stops[stops.length - 1]];
  }
  return Array.from({ length: count }, (_, index) => interpolateStops(stops, index / (count - 1)));
}

/** The palette color for the category at `index`, cycling past the end. */
export function categoryColor(index: number): string {
  return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
}

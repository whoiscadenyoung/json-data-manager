/**
 * Chart colors for the app builder — the dataviz reference palette
 * (validated: adjacent-pair CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, both modes),
 * with the dark column stepped for the dark surface rather than flipped.
 * Categorical slots are assigned in fixed order and never cycled: a chart
 * shows at most `CATEGORICAL_LIMIT` named groups and folds the rest into a
 * neutral "Other".
 */
export const CATEGORICAL = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
} as const;

/** "Other" — deliberately colorless so it never reads as a ninth series. */
export const OTHER_COLOR = { dark: "#6b6a65", light: "#a3a29c" } as const;

/** Named slices a donut draws before folding into Other. */
export const CATEGORICAL_LIMIT = 7;

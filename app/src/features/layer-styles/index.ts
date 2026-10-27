// Public API of the layer styles feature module (ADR 0012, ADR 0014). Code
// outside `features/layer-styles/` imports from here, never from internals.
export { useLayerStyles } from "./use-layer-styles";
export type { UseLayerStylesOptions, UseLayerStylesResult } from "./use-layer-styles";

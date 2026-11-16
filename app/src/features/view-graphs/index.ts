// Public API of the view-graphs feature (ADR 0014). Code outside
// `features/view-graphs/` imports from here, never from its subfolders.
export { LineageGraph } from "./components/lineage-graph";
export { LineageGraphView, LineageLegend } from "./components/lineage-graph-view";
export { ViewStepGraph } from "./components/view-step-graph";
export type { ViewStepGraphProps } from "./components/view-step-graph";
export type { Graph, GraphEdge, GraphNode, GraphNodeBadge, StepSelection } from "./lib/graph-types";
export { buildLineageGraph } from "./lib/lineage-graph";
export type { LineageData } from "./lib/lineage-graph";
export { STEP_KIND_VISUALS, stepKindVisual } from "./lib/step-kind";
export type { StepKindVisual } from "./lib/step-kind";
export { buildViewStepGraph } from "./lib/step-graph";
export type { StepGraphOptions, StepNodeOverride } from "./lib/step-graph";

// Public API of the view-graphs feature (ADR 0014). Code outside
// `features/view-graphs/` imports from here, never from its subfolders.
export { LineageGraph } from "./components/lineage-graph";
export { LineageGraphView, LineageLegend } from "./components/lineage-graph-view";
export { ViewStepGraph } from "./components/view-step-graph";
export type { ViewStepGraphProps } from "./components/view-step-graph";
export type { Graph, GraphEdge, GraphNode, StepSelection } from "./lib/graph-types";
export { buildLineageGraph } from "./lib/lineage-graph";
export type { LineageData } from "./lib/lineage-graph";
export { buildViewStepGraph } from "./lib/step-graph";

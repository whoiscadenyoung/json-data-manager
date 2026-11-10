/**
 * The pure graph model both graphs share (views initiative #304, design §9).
 * No React and no layout library here: the builders produce this, the layout
 * module positions it, the components draw it.
 */

export type GraphNodeKind =
  | "dataset"
  | "view"
  | "map"
  | "layer"
  | "app"
  | "input"
  | "step"
  | "output";

/** A view's health on the lineage graph. `error` (latest run failed) wins over `stale`. */
export type GraphNodeStatus = "ok" | "stale" | "error";

/** Which step a step-graph node stands for: `index` into `steps`, `sub` into a join's `right.steps`. */
export interface StepSelection {
  index: number;
  sub?: number;
}

export interface GraphNode {
  /** Unique within one graph; lineage ids are `<kind>:<entity id>`. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** A short second line (refresh mode, step summary, ...). */
  detail?: string;
  status?: GraphNodeStatus;
  /** A node standing in for something the viewer cannot read. */
  unavailable?: boolean;
  /** Lineage nodes: the entity the node opens. */
  entityId?: string;
  /** Step nodes: the step it selects. */
  step?: StepSelection;
  /** Step nodes: the raw `kind` string, kept for unknown/future kinds. */
  stepKind?: string;
}

/** `input` solid (a view reads it), `relation` dashed, `consumer` (a layer/map/app uses it), `flow` step to step, `branch` a sub-pipeline or a join's right input. */
export type GraphEdgeKind = "input" | "relation" | "consumer" | "flow" | "branch";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PositionedGraph {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

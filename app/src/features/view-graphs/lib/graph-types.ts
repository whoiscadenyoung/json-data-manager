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
  /** View node graph: the id of the definition node it stands for (a source is an `input` node, anything else a `step` node). */
  nodeId?: string;
  /** View node graph: the raw `kind` string, kept for unknown/future kinds. */
  stepKind?: string;
  /** A short pill on the node (step graph: "Needs input", "Problem", "3 unmatched"). */
  badge?: GraphNodeBadge;
}

export interface GraphNodeBadge {
  label: string;
  tone: "neutral" | "warning" | "error";
}

/** `input` solid (a source node feeds a reader), `relation` dashed, `consumer` (a layer/map/app uses it), `flow` node to node. */
export type GraphEdgeKind = "input" | "relation" | "consumer" | "flow" | "branch";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  label?: string;
  /** View node graph: the connection a node inserted here would split (`target` is "result" for the connection into the output). */
  insert?: { source: string; target: string };
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

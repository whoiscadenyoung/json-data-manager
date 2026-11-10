import type { ElkNode } from "elkjs/lib/elk-api";
import ELK from "elkjs/lib/elk.bundled.js";

import type { Graph, GraphNode, PositionedGraph } from "./graph-types";

/** Node boxes the layout reserves (the node components render at exactly this size). */
export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 56;

const elk = new ELK();

export function nodeSize(_node: GraphNode): { width: number; height: number } {
  return { height: NODE_HEIGHT, width: NODE_WIDTH };
}

/**
 * Layered left-to-right auto-layout with elkjs. ELK breaks cycles itself, so
 * cyclic data lays out like any other graph. Edges whose ends are missing are
 * dropped before layout (ELK throws on them).
 */
export async function layoutGraph(graph: Graph): Promise<PositionedGraph> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const root: ElkNode = {
    children: graph.nodes.map((node) => ({ id: node.id, ...nodeSize(node) })),
    edges: graph.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.spacing.nodeNode": "36",
    },
  };
  const result = await elk.layout(root);
  const positions: PositionedGraph["positions"] = {};
  for (const child of result.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }
  return { height: result.height ?? 0, positions, width: result.width ?? 0 };
}

/** A cache key that changes exactly when the layout would: node ids + edge ids. */
export function graphSignature(graph: Graph): string {
  return `${graph.nodes.map((node) => node.id).join("|")}#${graph.edges.map((edge) => edge.id).join("|")}`;
}

import type { ViewDefinition } from "@caden/data-core/views";
import { cn } from "@caden/ui/lib/utils";

import type { GraphEdge, GraphNode } from "../lib/graph-types";
import { buildViewNodeGraph, nodeGraphId, type NodeGraphOptions } from "../lib/node-graph";
import { GraphView } from "./graph-view";

export interface ViewNodeGraphProps {
  /** The (possibly unsaved) definition to draw. */
  definition: ViewDefinition;
  /** The node highlighted in the graph. */
  selectedNode?: string | undefined;
  /** Called with the id of a clicked node (sources included). */
  onSelectNode?: (id: string) => void;
  /** Highlights the output node instead of a node. */
  outputSelected?: boolean;
  /** Called when the output node is clicked (absent = not selectable). */
  onSelectOutput?: () => void;
  /** Node text and badges the stored JSON doesn't carry. */
  options?: NodeGraphOptions;
  /** A control on each connection, given the connection a new node would split. */
  renderInsert?: (connection: { source: string; target: string }) => React.ReactNode;
  /** Sizing; the graph fills its box, so give it a height (default `h-80`). */
  className?: string;
}

/**
 * The view node graph: datasets and processing nodes joined by the reads
 * between them, ending in the output. Purely props-driven so the view page
 * keeps it in sync with the outline and settings: pass the selection in, take
 * clicks out. With `renderInsert` and `onSelectOutput` it is the editor's
 * canvas.
 */
export function ViewNodeGraph({
  definition,
  selectedNode,
  onSelectNode,
  outputSelected = false,
  onSelectOutput,
  options,
  renderInsert,
  className,
}: ViewNodeGraphProps) {
  const graph = buildViewNodeGraph(definition, options);
  const selectedNodeId = outputSelected
    ? "output"
    : selectedNode === undefined
      ? null
      : nodeGraphId(selectedNode);
  const select = (node: GraphNode): void => {
    if (node.kind === "output" && onSelectOutput !== undefined) {
      onSelectOutput();
    } else if (node.nodeId !== undefined && onSelectNode !== undefined) {
      onSelectNode(node.nodeId);
    }
  };
  const selectable = (node: GraphNode): boolean =>
    node.kind === "output"
      ? onSelectOutput !== undefined
      : node.nodeId !== undefined && onSelectNode !== undefined;
  return (
    <GraphView
      ariaLabel="View node graph"
      className={cn("h-80", className)}
      graph={graph}
      fitMinZoom={renderInsert === undefined ? undefined : 0.45}
      isNodeClickable={selectable}
      onNodeClick={onSelectNode === undefined && onSelectOutput === undefined ? undefined : select}
      renderEdgeAction={
        renderInsert === undefined
          ? undefined
          : (edge: GraphEdge): React.ReactNode =>
              edge.insert === undefined ? undefined : renderInsert(edge.insert)
      }
      selectedNodeId={selectedNodeId}
    />
  );
}

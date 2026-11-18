import type { ViewNodeGraphProps } from "@/features/view-graphs";
import { buildViewNodeGraph } from "@/features/view-graphs/lib/node-graph";

// Page tests mock the whole `@/features/view-graphs` module with this file, so
// the non-graph exports the editor uses pass straight through.
export { STEP_KIND_VISUALS, stepKindVisual } from "@/features/view-graphs/lib/step-kind";

/**
 * A test stand-in for the React Flow canvas (which needs a measured DOM): the
 * same graph, drawn as plain buttons. Page tests mock `@/features/view-graphs`
 * with this module, so the editor's wiring to the canvas (labels, badges,
 * selection, insert points) is still exercised.
 */
export function ViewNodeGraph({
  definition,
  onSelectNode,
  onSelectOutput,
  options,
  renderInsert,
}: ViewNodeGraphProps) {
  const graph = buildViewNodeGraph(definition, options);
  return (
    <div data-testid="node-canvas">
      {graph.nodes.map((node) => (
        <button
          data-badge={node.badge === undefined ? undefined : node.badge.label}
          data-node={node.id}
          key={node.id}
          onClick={() => {
            if (node.kind === "output" && onSelectOutput !== undefined) {
              onSelectOutput();
            } else if (node.nodeId !== undefined && onSelectNode !== undefined) {
              onSelectNode(node.nodeId);
            }
          }}
          type="button"
        >
          {node.label}
        </button>
      ))}
      {graph.edges.map((edge) =>
        edge.insert === undefined || renderInsert === undefined ? null : (
          <span key={edge.id}>{renderInsert(edge.insert)}</span>
        ),
      )}
    </div>
  );
}

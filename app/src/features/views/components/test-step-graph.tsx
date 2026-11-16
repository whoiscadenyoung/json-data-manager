import type { ViewStepGraphProps } from "@/features/view-graphs";
import { buildViewStepGraph } from "@/features/view-graphs/lib/step-graph";

// Page tests mock the whole `@/features/view-graphs` module with this file, so
// the non-graph exports the editor uses pass straight through.
export { STEP_KIND_VISUALS, stepKindVisual } from "@/features/view-graphs/lib/step-kind";

/**
 * A test stand-in for the React Flow canvas (which needs a measured DOM): the
 * same graph, drawn as plain buttons. Page tests mock `@/features/view-graphs`
 * with this module, so the editor's wiring to the canvas (labels, badges,
 * selection, insert points) is still exercised.
 */
export function ViewStepGraph({
  definition,
  onSelectInput,
  onSelectOutput,
  onSelectStep,
  options,
  renderInsert,
}: ViewStepGraphProps) {
  const graph = buildViewStepGraph(definition, options);
  return (
    <div data-testid="step-canvas">
      {graph.nodes.map((node) => (
        <button
          data-badge={node.badge === undefined ? undefined : node.badge.label}
          data-node={node.id}
          key={node.id}
          onClick={() => {
            if (node.step !== undefined && onSelectStep !== undefined) {
              onSelectStep(node.step);
            } else if (node.kind === "output" && onSelectOutput !== undefined) {
              onSelectOutput();
            } else if (node.inputAlias !== undefined && onSelectInput !== undefined) {
              onSelectInput(node.inputAlias);
            }
          }}
          type="button"
        >
          {node.label}
        </button>
      ))}
      {graph.edges.map((edge) =>
        edge.insertIndex === undefined || renderInsert === undefined ? null : (
          <span key={edge.id}>{renderInsert(edge.insertIndex)}</span>
        ),
      )}
    </div>
  );
}

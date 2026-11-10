import type { ViewDefinition } from "@caden/data-core/views";
import { cn } from "@caden/ui/lib/utils";

import type { GraphNode, StepSelection } from "../lib/graph-types";
import { buildViewStepGraph, stepGraphNodeId } from "../lib/step-graph";
import { GraphView } from "./graph-view";

export interface ViewStepGraphProps {
  /** The (possibly unsaved) definition to draw. */
  definition: ViewDefinition;
  /** The step highlighted in the graph, e.g. the one selected in the step list. `sub` addresses a join's inline sub-pipeline. */
  selectedStep?: StepSelection | null;
  /** Called with the step a clicked step node stands for. Input and output nodes are not selectable. */
  onSelectStep?: (selection: StepSelection) => void;
  /** Sizing; the graph fills its box, so give it a height (default `h-80`). */
  className?: string;
}

/**
 * The view step graph (design §9): inputs, then steps, then the output, with
 * a join's right input and inline sub-pipeline drawn as a branch into the
 * join. Purely props-driven so the view page can keep it in sync with the
 * step list: pass the list's selection in, take clicks out.
 */
export function ViewStepGraph({
  definition,
  selectedStep = null,
  onSelectStep,
  className,
}: ViewStepGraphProps) {
  const graph = buildViewStepGraph(definition);
  return (
    <GraphView
      ariaLabel="View step graph"
      className={cn("h-80", className)}
      graph={graph}
      onNodeClick={
        onSelectStep === undefined
          ? undefined
          : (node: GraphNode) => {
              if (node.step !== undefined) {
                onSelectStep(node.step);
              }
            }
      }
      selectedNodeId={selectedStep === null ? null : stepGraphNodeId(selectedStep)}
    />
  );
}

import type { ViewDefinition } from "@caden/data-core/views";
import { cn } from "@caden/ui/lib/utils";

import type { GraphEdge, GraphNode, StepSelection } from "../lib/graph-types";
import { buildViewStepGraph, stepGraphNodeId, type StepGraphOptions } from "../lib/step-graph";
import { GraphView } from "./graph-view";

export interface ViewStepGraphProps {
  /** The (possibly unsaved) definition to draw. */
  definition: ViewDefinition;
  /** The step highlighted in the graph, e.g. the one selected in the step list. `sub` addresses a join's inline sub-pipeline. */
  selectedStep?: StepSelection | null;
  /** Called with the step a clicked step node stands for. Input nodes are not selectable. */
  onSelectStep?: (selection: StepSelection) => void;
  /** Highlights an input node (by alias) instead of a step. */
  selectedInput?: string;
  /** Called with the alias of a clicked input node (absent = inputs are not selectable). */
  onSelectInput?: (alias: string) => void;
  /** Highlights the output node instead of a step. */
  outputSelected?: boolean;
  /** Called when the output node is clicked (absent = not selectable). */
  onSelectOutput?: () => void;
  /** Input titles, step labels and badges the stored JSON doesn't carry. */
  options?: StepGraphOptions;
  /** A control on each connection of the main flow, given the index a new step would take there. */
  renderInsert?: (index: number) => React.ReactNode;
  /** Sizing; the graph fills its box, so give it a height (default `h-80`). */
  className?: string;
}

/**
 * The view step graph (design §9): inputs, then steps, then the output, with
 * a join's right input and inline sub-pipeline drawn as a branch into the
 * join. Purely props-driven so the view page can keep it in sync with the
 * step list: pass the selection in, take clicks out (steps, inputs, output). With
 * `renderInsert` and `onSelectOutput` it is the editor's canvas.
 */
export function ViewStepGraph({
  definition,
  selectedStep = null,
  onSelectStep,
  selectedInput,
  onSelectInput,
  outputSelected = false,
  onSelectOutput,
  options,
  renderInsert,
  className,
}: ViewStepGraphProps) {
  const graph = buildViewStepGraph(definition, options);
  const selectedNodeId = outputSelected
    ? "output"
    : selectedInput !== undefined
      ? `input:${selectedInput}`
      : selectedStep === null
        ? null
        : stepGraphNodeId(selectedStep);
  const select = (node: GraphNode): void => {
    if (node.step !== undefined && onSelectStep !== undefined) {
      onSelectStep(node.step);
    } else if (node.kind === "output" && onSelectOutput !== undefined) {
      onSelectOutput();
    } else if (node.inputAlias !== undefined && onSelectInput !== undefined) {
      onSelectInput(node.inputAlias);
    }
  };
  const selectable = (node: GraphNode): boolean => {
    if (node.kind === "output") {
      return onSelectOutput !== undefined;
    }
    return node.kind === "input" ? onSelectInput !== undefined : node.step !== undefined;
  };
  return (
    <GraphView
      ariaLabel="View step graph"
      className={cn("h-80", className)}
      graph={graph}
      fitMinZoom={renderInsert === undefined ? undefined : 0.45}
      isNodeClickable={selectable}
      onNodeClick={
        onSelectStep === undefined && onSelectOutput === undefined && onSelectInput === undefined
          ? undefined
          : select
      }
      renderEdgeAction={
        renderInsert === undefined
          ? undefined
          : (edge: GraphEdge): React.ReactNode =>
              edge.insertIndex === undefined ? undefined : renderInsert(edge.insertIndex)
      }
      selectedNodeId={selectedNodeId}
    />
  );
}

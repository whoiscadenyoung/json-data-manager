import type { ValidationError, ViewDefinition } from "@caden/data-core/views";

import type { NodeOverride } from "@/features/view-graphs";

import { nodeDiagnosticsOf } from "./diagnostics";
import { errorsForNode, nodeLabel, nodeProblem, nodeSummary, type InputInfo } from "./view-model";

/**
 * What the editor's canvas shows on a node (the graph itself only reads
 * stored JSON): the node's label, the same one-line summary as the outline,
 * and the most urgent thing to know about it.
 */

export interface CanvasContext {
  definition: ViewDefinition;
  infos: readonly InputInfo[];
  /** Every validation error of the definition. */
  errors: readonly ValidationError[];
  /** The raw diagnostics payload of the current preview. */
  diagnostics: unknown;
  /** Node ids the result does not need. */
  unused: ReadonlySet<string>;
}

/** A missing choice first, then a validation error, then a join that left rows unmatched, then "Unused". */
function badgeOf(ctx: CanvasContext, id: string): NodeOverride["badge"] {
  const node = ctx.definition.nodes[id];
  if (nodeProblem(node) !== undefined) {
    return { label: "Needs input", tone: "neutral" };
  }
  if (errorsForNode(ctx.errors, id).length > 0) {
    return { label: "Problem", tone: "error" };
  }
  const diagnostics = nodeDiagnosticsOf(ctx.diagnostics, id);
  if (diagnostics !== undefined && diagnostics.join !== undefined) {
    const unmatched = diagnostics.join.leftUnmatched;
    if (unmatched > 0) {
      return { label: `${unmatched.toLocaleString()} unmatched`, tone: "warning" };
    }
  }
  return ctx.unused.has(id) ? { label: "Unused", tone: "neutral" } : undefined;
}

/** The node text and badge of a node. Unknown ids are left to the graph's defaults. */
export function describeCanvasNode(ctx: CanvasContext, id: string): NodeOverride | undefined {
  if (!Object.hasOwn(ctx.definition.nodes, id)) {
    return undefined;
  }
  return {
    badge: badgeOf(ctx, id),
    detail: nodeSummary(ctx.definition, ctx.infos, id),
    label: nodeLabel(ctx.definition, ctx.infos, id),
  };
}

/** The output node's second line: how many fields the saved rows carry. */
export function canvasOutputDetail(
  definition: ViewDefinition,
  fields: readonly string[] | undefined,
): string | undefined {
  const kept = definition.result.output.fields.length;
  if (kept > 0) {
    return `${kept} fields kept`;
  }
  return fields === undefined ? undefined : `All fields (${fields.length})`;
}

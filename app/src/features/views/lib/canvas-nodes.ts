import type { JoinStep, Step, ValidationError, ViewDefinition } from "@caden/data-core/views";

import type { StepNodeOverride, StepSelection } from "@/features/view-graphs";

import { stepDiagnosticsOf } from "./diagnostics";
import { errorsForStep, stepProblem, stepSummary, STEP_TITLES, type InputInfo } from "./view-model";

/**
 * What the editor's canvas shows on a step node (the step graph itself only
 * reads stored JSON): the step's number and title, the same one-line summary
 * as the step list, and the most urgent thing to know about it.
 */

export interface CanvasContext {
  definition: ViewDefinition;
  infos: readonly InputInfo[];
  /** Every validation error of the definition. */
  errors: readonly ValidationError[];
  /** The raw diagnostics payload of the current preview. */
  diagnostics: unknown;
}

/** A missing choice first, then a validation error, then a join that left rows unmatched. */
function badgeOf(
  ctx: CanvasContext,
  step: Step,
  path: string,
  index: number,
  nested: boolean,
): StepNodeOverride["badge"] {
  if (stepProblem(step) !== undefined) {
    return { label: "Needs input", tone: "neutral" };
  }
  if (errorsForStep(ctx.errors, path).length > 0) {
    return { label: "Problem", tone: "error" };
  }
  const diagnostics = nested
    ? stepDiagnosticsOf(ctx.diagnostics, index, path)
    : stepDiagnosticsOf(ctx.diagnostics, index);
  if (diagnostics === undefined || diagnostics.join === undefined) {
    return undefined;
  }
  const unmatched = diagnostics.join.leftUnmatched;
  return unmatched > 0
    ? { label: `${unmatched.toLocaleString()} unmatched`, tone: "warning" }
    : undefined;
}

function subStepOf(
  step: Step | undefined,
  sub: number,
): { join: JoinStep; step: Step } | undefined {
  if (step === undefined || step.kind !== "join" || step.right.steps === undefined) {
    return undefined;
  }
  const found = step.right.steps[sub];
  return found === undefined ? undefined : { join: step, step: found };
}

/** The node text and badge of a step, by its place in the graph. Unknown places are left to the graph's defaults. */
export function describeCanvasStep(
  ctx: CanvasContext,
  selection: StepSelection,
): StepNodeOverride | undefined {
  const top = ctx.definition.steps[selection.index];
  if (top === undefined) {
    return undefined;
  }
  if (selection.sub === undefined) {
    return {
      badge: badgeOf(ctx, top, `steps[${selection.index}]`, selection.index, false),
      detail: stepSummary(top, ctx.infos),
      label: `${selection.index + 1}. ${STEP_TITLES[top.kind]}`,
    };
  }
  const nested = subStepOf(top, selection.sub);
  if (nested === undefined) {
    return undefined;
  }
  const path = `steps[${selection.index}].right.steps[${selection.sub}]`;
  return {
    badge: badgeOf(ctx, nested.step, path, selection.sub, true),
    detail: stepSummary(nested.step, ctx.infos),
    label: `${selection.index + 1}.${selection.sub + 1} ${STEP_TITLES[nested.step.kind]}`,
  };
}

/** Input titles by alias, for the graph's input nodes. */
export function canvasInputTitles(infos: readonly InputInfo[]): Record<string, string> {
  return Object.fromEntries(infos.map((info) => [info.alias, info.title]));
}

/** The output node's second line: how many fields the saved rows carry. */
export function canvasOutputDetail(
  definition: ViewDefinition,
  fields: readonly string[] | undefined,
): string | undefined {
  const kept = definition.output.fields.length;
  if (kept > 0) {
    return `${kept} fields kept`;
  }
  return fields === undefined ? undefined : `All fields (${fields.length})`;
}

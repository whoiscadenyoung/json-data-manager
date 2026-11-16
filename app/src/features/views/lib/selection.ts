import type { ViewDefinition } from "@caden/data-core/views";

/**
 * What the view editor has selected: a top-level step by index, a step inside
 * a join's sub-pipeline (#334), one of the inputs by alias, or the result.
 * The canvas, the step outline, the settings panel and the preview all follow
 * this one value.
 */
export const OUTPUT = "output" as const;

export interface NestedSelection {
  join: number;
  step: number;
}

export interface InputSelection {
  input: string;
}

export type Selection = NestedSelection | InputSelection | number | typeof OUTPUT;

export function nestedOf(selection: Selection): NestedSelection | undefined {
  return typeof selection === "object" && "join" in selection ? selection : undefined;
}

/** The selected input's alias, if an input is selected. */
export function inputOf(selection: Selection): string | undefined {
  return typeof selection === "object" && "input" in selection ? selection.input : undefined;
}

/** The top-level step whose settings are open: the step itself, or the join a nested step belongs to. */
export function openStepOf(selection: Selection): number | undefined {
  if (typeof selection === "number") {
    return selection;
  }
  const nested = nestedOf(selection);
  return nested === undefined ? undefined : nested.join;
}

/**
 * The selection the editor acts on after an edit: the picked one while it
 * still names something in the definition, otherwise the nearest thing that
 * does. A sub-step that is gone falls back to its join, and a step or input
 * that is gone falls back to the result.
 */
export function settleSelection(selection: Selection, definition: ViewDefinition): Selection {
  if (selection === OUTPUT) {
    return OUTPUT;
  }
  if (typeof selection === "number") {
    return selection < definition.steps.length ? selection : OUTPUT;
  }
  if ("input" in selection) {
    return definition.inputs.some((input) => input.alias === selection.input) ? selection : OUTPUT;
  }
  const join = definition.steps[selection.join];
  if (join === undefined) {
    return OUTPUT;
  }
  const subSteps = join.kind === "join" ? (join.right.steps ?? []) : [];
  return selection.step < subSteps.length ? selection : selection.join;
}

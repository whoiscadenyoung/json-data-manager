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

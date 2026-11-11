import type { DatasetKind } from "#/lib/store/datasets";

/** Why a view's rows cannot be edited here (the database guard refuses the write too). */
export const VIEW_ROWS_HINT =
  "This is a view: its rows come from running its steps, so they can't be edited or imported here. Change the steps in the view editor instead.";

/**
 * Views behave like datasets everywhere except writes: their rows are saved
 * by a run, never edited. Returns the reason to show on disabled or hidden
 * edit and import controls, or undefined for an ordinary dataset.
 */
export function viewRowsReadOnlyReason(dataset: { kind: DatasetKind }): string | undefined {
  return dataset.kind === "view" ? VIEW_ROWS_HINT : undefined;
}

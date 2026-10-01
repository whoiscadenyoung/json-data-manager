/**
 * The dataset edit policy's shared UI vocabulary (issue #124, ADR 0010):
 * `editPolicy: "locked"` answers every write to the dataset's creator, and
 * the UI says so everywhere the same way — one hint string, one predicate —
 * so the explanation a viewer reads never drifts between surfaces.
 */

/** Why a control is disabled on a locked dataset (the title on every gated action). */
export const LOCKED_DATASET_HINT =
  "This dataset is locked by its creator — only they can make changes to it. Everyone can still view and export it.";

/**
 * Whether write controls are locked FOR THIS VIEWER: the dataset is
 * `editPolicy: "locked"` and they aren't its creator. Reads are never
 * gated — `publishedVisibility` decides who may see a dataset, this only
 * decides who may change it.
 */
export function isLockedForViewer(
  schema:
    | {
        createdBy?: string;
        editPolicy?: "open" | "locked";
      }
    | null
    | undefined,
  me: { authId: string } | null | undefined,
): boolean {
  if (schema === undefined || schema === null) {
    return false;
  }
  return (
    schema.editPolicy === "locked" &&
    !(me !== undefined && me !== null && me.authId === schema.createdBy)
  );
}

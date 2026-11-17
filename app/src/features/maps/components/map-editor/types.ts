/** What is selected in the layer list. A row is a placement on the map or a layer inside a group. */
export interface LayerSelection {
  /** The row's id: the placement's, or the group child's. */
  rowId: string;
  kind: "data" | "group" | "linked";
  /** The owned layer (data or group); undefined for a linked layer. */
  layerId: string | undefined;
  /** The published version a linked layer is pinned to. */
  versionId: string | undefined;
  name: string;
}

/** A removal waiting on the confirm dialog. */
export interface PendingRemoval {
  confirmLabel: string;
  description: string;
  run: () => Promise<unknown>;
  title: string;
}

/** Runs one write, reports a failure, and refreshes the editor's reads. */
export type RunWrite = (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;

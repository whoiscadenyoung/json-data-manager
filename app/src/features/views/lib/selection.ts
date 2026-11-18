import type { ViewDefinition } from "@caden/data-core/views";

/**
 * What the view editor has selected: a node by id, or the output. The
 * canvas, the outline, the settings panel and the preview all follow this one
 * value.
 */
export const OUTPUT = "output" as const;

export interface NodeSelection {
  node: string;
}

export type Selection = NodeSelection | typeof OUTPUT;

/** The selected node's id, if a node is selected. */
export function nodeOf(selection: Selection): string | undefined {
  return selection === OUTPUT ? undefined : selection.node;
}

/**
 * The selection the editor acts on after an edit: the picked one while it
 * still names a node of the definition, otherwise the output.
 */
export function settleSelection(selection: Selection, definition: ViewDefinition): Selection {
  if (selection === OUTPUT) {
    return OUTPUT;
  }
  return Object.hasOwn(definition.nodes, selection.node) ? selection : OUTPUT;
}

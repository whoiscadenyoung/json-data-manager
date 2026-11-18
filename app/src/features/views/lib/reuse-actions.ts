import { applyExtract, planExtract } from "@caden/data-core/views";
import type { ViewDefinition } from "@caden/data-core/views";

import { runView, viewDeps } from "@/lib/store/views";
import { saveView } from "@/lib/views/view-save";

import { createProjectView } from "./create-view";
import { inputRefsOf } from "./view-model";

/**
 * The write side of Extract to view (#307): create the new view, run it once
 * so its rows (and so its field list) exist, then save the edited view that
 * now reads it. The pure rewriting is `@caden/data-core/views` (`reuse.ts`): the node becomes a source reading the new view.
 */

/** The new view was created, but the edit did not land; the original view is unchanged. */
export class ExtractIncompleteError extends Error {
  readonly newViewId: string;
  constructor(message: string, newViewId: string) {
    super(message);
    this.name = "ExtractIncompleteError";
    this.newViewId = newViewId;
  }
}

export interface ExtractOutcome {
  newViewId: string;
  /** The edited definition (already saved). */
  definition: ViewDefinition;
  rowCount: number;
}

export async function extractNodeToView(args: {
  definition: ViewDefinition;
  /** The node to move into its own view (with everything it reads). */
  node: string;
  newTitle: string;
  projectId: string;
  viewId: string;
}): Promise<ExtractOutcome> {
  const planned = planExtract(args.definition, args.node);
  if (!planned.ok) {
    throw new Error(planned.reason);
  }
  const newViewId = await createProjectView({
    definition: planned.plan.view,
    projectId: args.projectId,
    title: args.newTitle,
  });
  const outcome = await runView(newViewId);
  if (outcome.status !== "ok") {
    throw new ExtractIncompleteError(
      `The new view "${args.newTitle}" was created but its first run failed (${outcome.error}). This view was left unchanged: fix the new view, run it, then try again.`,
      newViewId,
    );
  }
  const edited = applyExtract(args.definition, args.node, planned.plan, { id: newViewId });
  try {
    await saveView(viewDeps(), args.viewId, { definition: edited, inputs: inputRefsOf(edited) });
  } catch (error) {
    throw new ExtractIncompleteError(
      `The new view "${args.newTitle}" was created and run, but this view couldn't be updated to read it: ${error instanceof Error ? error.message : "save failed"}. This view was left unchanged.`,
      newViewId,
    );
  }
  return { newViewId, definition: edited, rowCount: outcome.rowCount };
}

interface ViewSummary {
  id: string;
  title: string;
  inputs: { inputDatasetId: string }[];
}

function readsView(
  views: readonly ViewSummary[],
  from: string,
  target: string,
  seen: Set<string>,
): boolean {
  if (from === target) {
    return true;
  }
  if (seen.has(from)) {
    return false;
  }
  seen.add(from);
  const node = views.find((view) => view.id === from);
  return (
    node !== undefined &&
    node.inputs.some((input) => readsView(views, input.inputDatasetId, target, seen))
  );
}

/**
 * Plain words for a cycle error from Save ("saving this view would create a
 * cycle"): names the input that already reads this view. Undefined when the
 * error is not a cycle error.
 */
export function explainCycle(
  error: unknown,
  args: {
    viewId: string;
    /** Dataset ids of the draft's inputs. */
    inputIds: readonly string[];
    views: readonly ViewSummary[];
  },
): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (!/cycle/i.test(message)) {
    return undefined;
  }
  if (args.inputIds.includes(args.viewId)) {
    return "A view can't read itself. Pick a different dataset for that input.";
  }
  const culprit = args.views.find(
    (view) =>
      args.inputIds.includes(view.id) &&
      view.inputs.some((input) =>
        readsView(args.views, input.inputDatasetId, args.viewId, new Set()),
      ),
  );
  if (culprit === undefined) {
    return "Views can't read each other in a loop: one of this view's inputs already reads this view.";
  }
  return `"${culprit.title}" already reads this view, so this view can't read it back. Pick a different input, or remove the join with "${culprit.title}".`;
}

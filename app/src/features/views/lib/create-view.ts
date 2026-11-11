import type { ViewDefinition } from "@caden/data-core/views";

import * as datasetsStore from "@/lib/store/datasets";
import * as projectsStore from "@/lib/store/projects";
import { viewDeps } from "@/lib/store/views";
import { createView } from "@/lib/views/view-save";

import { inputRefsOf } from "./view-model";

/**
 * Creates a view that is OWNED by the project, exactly like an in-project
 * dataset (ADR 0018): the dataset row first (`create_view`, a draft visible
 * to the project's members once bound), then the owned membership. If the
 * binding does not land (the caller is not an editor), the unbound view is
 * removed again so no invisible orphan stays behind.
 */
export async function createProjectView(args: {
  definition: ViewDefinition;
  projectId: string;
  title: string;
}): Promise<string> {
  const id = await createView(viewDeps(), {
    title: args.title,
    definition: args.definition,
    inputs: inputRefsOf(args.definition),
    lifecycle: "draft",
    visibility: "members",
  });
  const outcome = await projectsStore.addArtifact({
    artifactId: id,
    artifactKind: "dataset",
    projectId: args.projectId,
    role: "owned",
  });
  if (outcome.artifact === null) {
    try {
      await datasetsStore.remove({ datasetId: id });
    } catch {
      // Best effort: the original failure is the news.
    }
    throw new Error("The project binding didn't land: you may not have access to this project.");
  }
  return id;
}

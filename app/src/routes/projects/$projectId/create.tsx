import { createFileRoute } from "@tanstack/react-router";

import { CreateDatasetPage } from "#/features/datasets";

/**
 * The in-project create/import flow (issue #256, the project-centric train's
 * phase 2; ADR 0018): the dataset lands IN the project as an OWNED DRAFT —
 * bound to the workspace at birth (member-visible per the ADR 0017 deferred
 * clause), staying a draft until an explicit publish. Reached from the
 * project catalog's "Create / import" affordances.
 */
export const Route = createFileRoute("/projects/$projectId/create")({
  component: ProjectCreatePage,
});

function ProjectCreatePage() {
  const { projectId } = Route.useParams();
  return <CreateDatasetPage projectId={projectId} />;
}

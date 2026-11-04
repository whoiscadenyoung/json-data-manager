import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PostgresCreateDatasetPage } from "#/features/datasets";

/**
 * `?projectId=` puts the page in the in-project variant (roadmap 7a, #102):
 * the dataset is created through the host's draft flow so it lands IN the
 * project, part of the flow, not a separate act (lifecycle §3). Absent, the
 * page is the standalone Postgres create/import flow (design doc §14.1).
 */
const createSearchSchema = z.object({
  projectId: z.string().optional(),
});

export const Route = createFileRoute("/datasets/create")({
  component: CreateDatasetPage,
  validateSearch: createSearchSchema,
});

/**
 * The create route, collapsed by the stage-7 disconnect (issue #206): the
 * standalone flow was Postgres-native from stage 1 and stays. The
 * in-project variant — the Convex `createDraftDataset` host flow serving the
 * pre-migration Convex project workspaces — is ARCHIVED: its `convex/react`
 * mutations would throw against the unmounted provider, and it was only
 * ever linked from the Convex project workspace (itself archived at the
 * route). The variant's logic was removed from the shell; it lives on in
 * the untouched `app/convex/` + `packages/json-cms/` reference trees. A
 * Postgres project's add-dataset flow is the project workspace's own
 * artifact sheet (`#/lib/store/projects.addArtifact`).
 */
function CreateDatasetPage() {
  const { projectId } = Route.useSearch();
  if (projectId === undefined) {
    return <PostgresCreateDatasetPage />;
  }
  return (
    <ArchivedConvexSurface
      description="In-project dataset creation served the pre-migration Convex project workspaces. Postgres projects add datasets from the project workspace directly."
      homeTo="/projects"
      title="Convex datasets are archived in this build"
    />
  );
}

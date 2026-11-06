import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PostgresCreateDatasetPage } from "#/features/datasets";
import { isPostgresDatasetId } from "#/lib/dataset-source";

/**
 * `?projectId=` puts the page in the in-project variant: since #256 the
 * variant lives at its project route (`/projects/$projectId/create` — the
 * owned-draft flow, ADR 0018), so a legacy deep link forwards there. The
 * bare page is the standalone Postgres create/import flow (design §14.1).
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
 * standalone flow was Postgres-native from stage 1 and stays. The in-project
 * variant the Convex `createDraftDataset` host flow used to serve returned
 * with #256 as the PG owned-draft flow at `/projects/$projectId/create` —
 * this route forwards a `?projectId=` deep link there instead of dead-ending.
 */
function CreateDatasetPage() {
  const { projectId } = Route.useSearch();
  if (projectId === undefined) {
    return <PostgresCreateDatasetPage />;
  }
  if (isPostgresDatasetId(projectId)) {
    throw redirect({ params: { projectId }, to: "/projects/$projectId/create" });
  }
  return (
    <ArchivedConvexSurface
      description="In-project dataset creation served the pre-migration Convex project workspaces. Postgres projects create datasets from the project workspace directly."
      homeTo="/projects"
      title="Convex projects are archived in this build"
    />
  );
}

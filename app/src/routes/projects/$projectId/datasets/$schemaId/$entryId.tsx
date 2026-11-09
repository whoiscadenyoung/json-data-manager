import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { DatasetProjectContext, PostgresEntryDetailsPage } from "#/features/datasets";
import { isPostgresDatasetId } from "@/lib/dataset-source";

/** The entry-details page inside the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/datasets/$schemaId/$entryId")({
  component: ProjectEntryPage,
});

function ProjectEntryPage() {
  const { entryId, projectId, schemaId } = Route.useParams();
  if (!isPostgresDatasetId(schemaId)) {
    return <ArchivedConvexSurface />;
  }
  return (
    <DatasetProjectContext.Provider value={projectId}>
      <PostgresEntryDetailsPage entryId={entryId} schemaId={schemaId} />
    </DatasetProjectContext.Provider>
  );
}

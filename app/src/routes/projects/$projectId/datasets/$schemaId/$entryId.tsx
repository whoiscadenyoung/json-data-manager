import { createFileRoute } from "@tanstack/react-router";

import { DatasetProjectContext, PostgresEntryDetailsPage } from "#/features/datasets";

/** The entry-details page inside the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/datasets/$schemaId/$entryId")({
  component: ProjectEntryPage,
});

function ProjectEntryPage() {
  const { entryId, projectId, schemaId } = Route.useParams();
  return (
    <DatasetProjectContext.Provider value={projectId}>
      <PostgresEntryDetailsPage entryId={entryId} schemaId={schemaId} />
    </DatasetProjectContext.Provider>
  );
}

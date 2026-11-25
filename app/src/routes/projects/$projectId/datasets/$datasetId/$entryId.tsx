import { createFileRoute } from "@tanstack/react-router";

import { DatasetProjectContext, EntryDetailsPage } from "#/features/datasets";

/** The entry-details page inside the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/datasets/$datasetId/$entryId")({
  component: ProjectEntryPage,
});

function ProjectEntryPage() {
  const { entryId, projectId, datasetId } = Route.useParams();
  return (
    <DatasetProjectContext.Provider value={projectId}>
      <EntryDetailsPage entryId={entryId} datasetId={datasetId} />
    </DatasetProjectContext.Provider>
  );
}

import { createFileRoute } from "@tanstack/react-router";

import { EntryDetailsPage } from "#/features/datasets";

export const Route = createFileRoute("/datasets/$datasetId/$entryId")({
  component: EntryDetailPage,
});

/** The entry-details page. */
function EntryDetailPage() {
  const { entryId, datasetId } = Route.useParams();
  return <EntryDetailsPage entryId={entryId} datasetId={datasetId} />;
}

import { createFileRoute } from "@tanstack/react-router";

import { PostgresEntryDetailsPage } from "#/features/datasets";

export const Route = createFileRoute("/datasets/$schemaId/$entryId")({
  component: EntryDetailPage,
});

/** The entry-details page. */
function EntryDetailPage() {
  const { entryId, schemaId } = Route.useParams();
  return <PostgresEntryDetailsPage entryId={entryId} schemaId={schemaId} />;
}

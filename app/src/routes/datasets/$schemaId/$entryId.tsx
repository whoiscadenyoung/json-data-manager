import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PostgresEntryDetailsPage } from "#/features/datasets";
import { isPostgresDatasetId } from "@/lib/dataset-source";

export const Route = createFileRoute("/datasets/$schemaId/$entryId")({
  component: EntryDetailPage,
});

/**
 * The entry-details page. Transitional split (design doc §14), collapsed by
 * the stage-7 disconnect (issue #206): uuid ids were minted by the Postgres
 * backend — their entry details read through the store modules
 * (`PostgresEntryDetailsPage`). A pre-migration Convex dataset's entry
 * renders the shared ARCHIVED state instead of the old Convex reads (the
 * seam point-reads, the `listReferencingEntries` subscription, the convex
 * candidate lookup), whose `convex/react` hooks would throw against the
 * unmounted provider. The Convex body was removed from the shell; the
 * untouched `app/convex/` + `packages/json-cms/` trees remain the reference.
 */
function EntryDetailPage() {
  const { entryId, schemaId } = Route.useParams();
  if (isPostgresDatasetId(schemaId)) {
    return <PostgresEntryDetailsPage entryId={entryId} schemaId={schemaId} />;
  }
  return <ArchivedConvexSurface />;
}

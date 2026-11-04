import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";

export const Route = createFileRoute("/datasets/$schemaId/bulk-upload")({
  component: BulkUploadPage,
});

/**
 * ARCHIVED at the stage-7 disconnect (issue #206): this page was the Convex
 * bulk importer (`api.cms.schemas.get`, `api.cms.imports.*` through
 * `convex/react`, Convex file storage for the chunks). Postgres datasets
 * never used it — the PG import path is the create flow's `import_entries`
 * pipeline (`#/lib/store/*` + Storage buckets) — so the route served only
 * pre-migration Convex datasets, and with the provider unmounted its hooks
 * would throw against a missing client. It renders the shared archived
 * state; the importer logic was removed from the shell and lives on in the
 * untouched `app/convex/` + `packages/json-cms/` reference trees.
 */
function BulkUploadPage() {
  return <ArchivedConvexSurface />;
}

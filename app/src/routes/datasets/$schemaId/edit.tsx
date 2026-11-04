import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";

export const Route = createFileRoute("/datasets/$schemaId/edit")({
  component: EditSchemaPage,
});

/**
 * ARCHIVED at the stage-7 disconnect (issue #206): this page was the Convex
 * schema editor (`api.cms.schemas.get`/`update` through `convex/react`) —
 * the only schema editor the app had, and it only ever edited pre-migration
 * Convex datasets (Postgres datasets carry no edit route; their page owns
 * the metadata it can change). With the provider unmounted its hooks would
 * throw against a missing client, so the route renders the shared archived
 * state; the editor logic was removed from the shell and lives on in the
 * untouched `app/convex/` + `packages/json-cms/` reference trees.
 */
function EditSchemaPage() {
  return <ArchivedConvexSurface />;
}

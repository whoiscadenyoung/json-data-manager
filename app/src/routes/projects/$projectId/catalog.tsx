import { createFileRoute } from "@tanstack/react-router";

import { PgProjectCatalog } from "#/features/publishing";

/** Catalog section of the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/catalog")({
  component: PgProjectCatalog,
});

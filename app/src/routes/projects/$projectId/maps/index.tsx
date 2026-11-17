import { createFileRoute } from "@tanstack/react-router";

import { PgProjectMaps } from "#/features/publishing";

/** Maps section of the project shell: the project's maps as one table. */
export const Route = createFileRoute("/projects/$projectId/maps/")({
  component: PgProjectMaps,
});

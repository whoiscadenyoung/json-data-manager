import { createFileRoute } from "@tanstack/react-router";

import { PgProjectAnalysis } from "#/features/publishing";

/** Analysis section of the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/analysis")({
  component: PgProjectAnalysis,
});

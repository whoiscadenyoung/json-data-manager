import { createFileRoute } from "@tanstack/react-router";

import { ProjectSettings } from "#/features/publishing";

/** Settings section of the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettings,
});

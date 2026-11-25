import { createFileRoute } from "@tanstack/react-router";

import { ProjectApps } from "#/features/publishing";

/** Apps section of the project shell: the project's apps as one table. */
export const Route = createFileRoute("/projects/$projectId/apps/")({
  component: ProjectApps,
});

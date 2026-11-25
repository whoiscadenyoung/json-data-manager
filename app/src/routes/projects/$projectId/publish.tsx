import { createFileRoute } from "@tanstack/react-router";

import { ProjectPublish } from "#/features/publishing";

/** Publish section of the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/publish")({
  component: ProjectPublish,
});

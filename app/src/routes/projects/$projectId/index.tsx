import { createFileRoute } from "@tanstack/react-router";

import { ProjectOverview } from "#/features/publishing";

/** Overview — the shell's default section (issue #271). The archive gate lives in the layout. */
export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectOverview,
});

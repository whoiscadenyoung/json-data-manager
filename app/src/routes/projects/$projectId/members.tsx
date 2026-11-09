import { createFileRoute } from "@tanstack/react-router";

import { PgProjectMembers } from "#/features/publishing";

/** Members section of the project shell (issue #271). */
export const Route = createFileRoute("/projects/$projectId/members")({
  component: PgProjectMembers,
});

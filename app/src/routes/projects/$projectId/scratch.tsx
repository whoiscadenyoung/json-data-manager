import { createFileRoute } from "@tanstack/react-router";

import { ScratchPage } from "#/features/scratch";

/** Scratch query section of the project shell (#306; replaces the Analysis tab). */
export const Route = createFileRoute("/projects/$projectId/scratch")({
  component: ScratchRoute,
});

function ScratchRoute() {
  const { projectId } = Route.useParams();
  return <ScratchPage projectId={projectId} />;
}

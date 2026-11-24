import { createFileRoute } from "@tanstack/react-router";

import { ProjectMapEditor } from "#/features/maps";

export const Route = createFileRoute("/projects/$projectId/maps/$mapId")({
  component: ProjectMapRoutePage,
});

/**
 * The in-project map editor (issue #257; D2: maps are made in projects). The
 * editor itself lives in `features/maps`.
 */
function ProjectMapRoutePage() {
  const { mapId, projectId } = Route.useParams();
  return <ProjectMapEditor key={mapId} mapId={mapId} projectId={projectId} />;
}

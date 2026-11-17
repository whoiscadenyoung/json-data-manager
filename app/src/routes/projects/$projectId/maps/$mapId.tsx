import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { ProjectMapEditor } from "#/features/maps";
import { isPostgresDatasetId } from "#/lib/dataset-source";

export const Route = createFileRoute("/projects/$projectId/maps/$mapId")({
  component: ProjectMapRoutePage,
});

/**
 * The in-project map editor (issue #257; D2: maps are made in projects). The
 * editor itself lives in `features/maps`. A pre-migration Convex map id
 * renders the shared archived state.
 */
function ProjectMapRoutePage() {
  const { mapId, projectId } = Route.useParams();
  if (isPostgresDatasetId(mapId) && isPostgresDatasetId(projectId)) {
    return <ProjectMapEditor key={mapId} mapId={mapId} projectId={projectId} />;
  }
  return (
    <ArchivedConvexSurface
      description="This workspace served maps created before the Postgres migration. Pre-migration maps were retired with the old backend."
      homeTo="/projects"
      title="Convex maps are archived in this build"
    />
  );
}

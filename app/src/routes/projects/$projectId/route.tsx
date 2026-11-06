import { Outlet, createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { isPostgresDatasetId } from "#/lib/dataset-source";

/**
 * The /projects/$projectId LAYOUT (issue #258 fix, found live): the old
 * `$projectId.tsx` carried the full workspace component with no <Outlet/>,
 * which MASKED its children — /projects/$projectId/create and
 * /projects/$projectId/maps/$mapId both rendered the workspace at their own
 * URLs (the editor had become unreachable; main b165729 shipped this). The
 * layout keeps the Convex-archive gate in one place; the workspace itself
 * lives in the index route, the children nest under the Outlet.
 */
export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  if (!isPostgresDatasetId(projectId)) {
    return (
      <ArchivedConvexSurface
        description="This workspace served projects created before the Postgres migration. Pre-migration projects were retired with the old backend — Postgres projects are unaffected."
        homeTo="/projects"
        title="Convex projects are archived in this build"
      />
    );
  }
  return <Outlet />;
}

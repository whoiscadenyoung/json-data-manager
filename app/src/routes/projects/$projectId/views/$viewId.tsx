import { createFileRoute } from "@tanstack/react-router";

import { PgViewPage } from "#/features/views";

/** The view editor (issue #301): steps, previews with diagnostics, Save, Run and run history. */
export const Route = createFileRoute("/projects/$projectId/views/$viewId")({
  component: ViewRoute,
});

function ViewRoute() {
  const { projectId, viewId } = Route.useParams();
  return <PgViewPage projectId={projectId} viewId={viewId} />;
}

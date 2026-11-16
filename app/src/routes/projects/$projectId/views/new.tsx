import { createFileRoute } from "@tanstack/react-router";

import { NewViewPage } from "#/features/views";

/** "New view" on the canvas: a title and the dataset the view starts from, then the editor. */
export const Route = createFileRoute("/projects/$projectId/views/new")({
  component: NewViewRoute,
});

function NewViewRoute() {
  const { projectId } = Route.useParams();
  return <NewViewPage projectId={projectId} />;
}

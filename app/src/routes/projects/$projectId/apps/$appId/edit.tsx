import { createFileRoute } from "@tanstack/react-router";

import { AppBuilderPage, pageSearch } from "#/features/app-builder";

/**
 * The app builder inside the project shell (issue #271): the same canvas as
 * `/apps/$appId/edit`, rendered in the shell's content area with the sidebar
 * collapsed to the rail by default. `?page=` picks the page it opens on.
 */
export const Route = createFileRoute("/projects/$projectId/apps/$appId/edit")({
  component: ProjectAppBuilderRoute,
  validateSearch: pageSearch,
});

function ProjectAppBuilderRoute() {
  const { appId } = Route.useParams(),
    { page } = Route.useSearch();
  return <AppBuilderPage key={appId} appId={appId} embedded initialPageId={page} />;
}

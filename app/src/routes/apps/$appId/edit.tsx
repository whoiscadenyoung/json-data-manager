import { createFileRoute } from "@tanstack/react-router";

import { AppBuilderPage, pageSearch } from "#/features/app-builder";

/**
 * The app builder canvas (docs/app-builder.md). `?page=` picks the page it
 * opens on. Ported to the Postgres `apps` store in issue #216.
 */
export const Route = createFileRoute("/apps/$appId/edit")({
  component: AppBuilderRoute,
  validateSearch: pageSearch,
});

function AppBuilderRoute() {
  const { appId } = Route.useParams(),
    { page } = Route.useSearch();
  return <AppBuilderPage key={appId} appId={appId} initialPageId={page} />;
}

import { useQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { AppBuilderPage, pageSearch } from "#/features/app-builder";
import * as appsStore from "@/lib/store/apps";

/**
 * The app builder canvas (docs/app-builder.md). `?page=` picks the page it
 * opens on. Ported to the Postgres `apps` store in issue #216. An app that
 * belongs to a project redirects into the project shell (issue #271) so the
 * old deep link keeps working.
 */
export const Route = createFileRoute("/apps/$appId/edit")({
  component: AppBuilderRoute,
  validateSearch: pageSearch,
});

function AppBuilderRoute() {
  const { appId } = Route.useParams(),
    { page } = Route.useSearch(),
    appQuery = useQuery(appsStore.getQueryOptions({ appId })),
    projectId =
      appQuery.data === null || appQuery.data === undefined ? null : appQuery.data.projectId;
  if (projectId !== null && typeof projectId === "string") {
    return (
      <Navigate
        params={{ appId, projectId }}
        replace
        search={{ page }}
        to="/projects/$projectId/apps/$appId/edit"
      />
    );
  }
  return <AppBuilderPage key={appId} appId={appId} initialPageId={page} />;
}

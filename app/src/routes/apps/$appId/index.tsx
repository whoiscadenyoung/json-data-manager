import { createFileRoute } from "@tanstack/react-router";

import { AppViewPage, pageSearch } from "#/features/app-builder";

/**
 * The share URL: the published app, read-only, drawn as a standalone app
 * without the product header (docs/app-builder.md). `?page=` names the open
 * tab so a link can point at any page; the first page stays out of the URL.
 */
export const Route = createFileRoute("/apps/$appId/")({
  component: AppViewRoute,
  staticData: { hideHeader: true },
  validateSearch: pageSearch,
});

function AppViewRoute() {
  const { appId } = Route.useParams(),
    { page } = Route.useSearch(),
    navigate = Route.useNavigate();
  return (
    <AppViewPage
      key={appId}
      appId={appId}
      mode="published"
      pageId={page}
      onPageChange={(next) => {
        void navigate({ search: (prev) => ({ ...prev, page: next }) });
      }}
    />
  );
}

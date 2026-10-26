import { createFileRoute } from "@tanstack/react-router";

import { AppViewPage } from "#/features/app-builder/pages/app-view-page";

/**
 * The share URL: an app, read-only (docs/app-builder.md). `?page=` names the
 * open tab so a link can point at any page; the first page is the default
 * and stays out of the URL.
 */
export const Route = createFileRoute("/apps/$appId/")({
  component: AppViewRoute,
  validateSearch: (search: Record<string, unknown>): { page?: string } =>
    typeof search.page === "string" && search.page !== "" ? { page: search.page } : {},
});

function AppViewRoute() {
  const { appId } = Route.useParams(),
    { page } = Route.useSearch(),
    navigate = Route.useNavigate();
  return (
    <AppViewPage
      key={appId}
      appId={appId}
      pageId={page}
      onPageChange={(next) => {
        void navigate({ search: (prev) => ({ ...prev, page: next }) });
      }}
    />
  );
}

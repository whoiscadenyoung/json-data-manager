import { createFileRoute } from "@tanstack/react-router";

import { AppViewPage, pageSearch } from "#/features/app-builder";

/**
 * The builder's preview: the app exactly as viewers see it, full page, under a
 * toolbar whose X returns to the builder on the same page. Ported to the
 * Postgres `apps` store in issue #216.
 */
export const Route = createFileRoute("/apps/$appId/preview")({
  component: AppPreviewRoute,
  staticData: { hideHeader: true },
  validateSearch: pageSearch,
});

function AppPreviewRoute() {
  const { appId } = Route.useParams(),
    { page } = Route.useSearch(),
    navigate = Route.useNavigate();
  return (
    <AppViewPage
      key={appId}
      appId={appId}
      mode="preview"
      pageId={page}
      onPageChange={(next) => {
        void navigate({ search: (prev) => ({ ...prev, page: next }) });
      }}
      onExit={() => {
        void navigate({
          params: { appId },
          search: (prev) => ({ ...prev, page }),
          to: "/apps/$appId/edit",
        });
      }}
    />
  );
}

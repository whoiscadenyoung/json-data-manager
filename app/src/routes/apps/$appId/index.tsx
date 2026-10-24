import { createFileRoute } from "@tanstack/react-router";

import { AppViewPage } from "#/features/app-builder/pages/app-view-page";

/** The share URL: an app, read-only (docs/app-builder.md). */
export const Route = createFileRoute("/apps/$appId/")({ component: AppViewRoute });

function AppViewRoute() {
  const { appId } = Route.useParams();
  return <AppViewPage key={appId} appId={appId} />;
}

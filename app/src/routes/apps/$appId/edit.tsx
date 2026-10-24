import { createFileRoute } from "@tanstack/react-router";

import { AppBuilderPage } from "#/features/app-builder/pages/app-builder-page";

/** The app builder canvas (docs/app-builder.md). */
export const Route = createFileRoute("/apps/$appId/edit")({ component: AppBuilderRoute });

function AppBuilderRoute() {
  const { appId } = Route.useParams();
  return <AppBuilderPage key={appId} appId={appId} />;
}

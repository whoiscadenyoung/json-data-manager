import { createFileRoute } from "@tanstack/react-router";

import { AppsPage } from "#/features/app-builder/pages/apps-page";

// The app builder's routes are thin shells over `features/app-builder`
// (docs/app-builder.md) — delete `routes/apps/` with the feature.
export const Route = createFileRoute("/apps/")({ component: AppsPage });

import { createFileRoute } from "@tanstack/react-router";

import { AppsPage } from "#/features/app-builder";

/**
 * The app builder's routes are thin shells over `features/app-builder`
 * (docs/app-builder.md) — delete `routes/apps/` with the feature. Ported to
 * the Postgres `apps` store in issue #216 (the stage-7 archive —
 * ArchivedConvexSurface — was the holding state; #198/#206).
 */
export const Route = createFileRoute("/apps/")({ component: AppsPage });

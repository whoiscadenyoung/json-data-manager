import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";

/**
 * ARCHIVED at the stage-7 disconnect (issue #206): the app builder reads and
 * writes `api.appBuilder.apps.*` through `convex/react` — its backend left
 * with the Convex provider, so every /apps surface renders the shared
 * archived state instead of hooks that would throw. Stage 7's `apps` tables
 * + `#/lib/store/apps` module are the Postgres home the builder ports to;
 * until that wiring lands, the Convex builder lives on only in the untouched
 * `app/convex/` + `packages/json-cms/` reference trees. The route shells are
 * kept (never deleted) so the port drops straight back in.
 */
export const Route = createFileRoute("/apps/")({ component: AppsRoute });

function AppsRoute() {
  return (
    <ArchivedConvexSurface
      description="Apps were built on the pre-migration Convex backend. The app builder is being ported to the Postgres apps store — existing apps retired with the old backend."
      homeTo="/datasets"
      title="Apps are archived in this build"
    />
  );
}

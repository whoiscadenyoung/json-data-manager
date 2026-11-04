import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";

/**
 * ARCHIVED at the stage-7 disconnect (issue #206) — see routes/apps/index.tsx
 * for the full note: the app builder's reads/writes ride `convex/react`
 * against the retired backend. `?page=` still names the open tab for the
 * eventual port.
 */

/** The `?page=` search param — the open tab, kept for the eventual port. */
const pageSearch = z.object({ page: z.string().optional() });

export const Route = createFileRoute("/apps/$appId/")({
  component: AppViewRoute,
  staticData: { hideHeader: true },
  validateSearch: pageSearch,
});

function AppViewRoute() {
  return (
    <ArchivedConvexSurface
      description="Published apps were served from the pre-migration Convex backend. Existing apps retired with the old backend; rebuilt apps will publish to Postgres."
      homeTo="/datasets"
      title="Apps are archived in this build"
    />
  );
}

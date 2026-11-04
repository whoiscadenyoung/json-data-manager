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

export const Route = createFileRoute("/apps/$appId/edit")({
  component: AppBuilderRoute,
  validateSearch: pageSearch,
});

function AppBuilderRoute() {
  return (
    <ArchivedConvexSurface
      description="The app builder canvas rode the pre-migration Convex backend. It is being ported to the Postgres apps store."
      homeTo="/datasets"
      title="Apps are archived in this build"
    />
  );
}

import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });

/**
 * ARCHIVED at the stage-7 disconnect (issue #206): this page was the CRUD
 * surface over the bound-datasets PoC's foreign-domain tables (restaurants,
 * locations, restaurantLocations) — the demo source's "source of truth"
 * side, every panel riding `convex/react` against the demo's Convex tables.
 * Issue #206 does NOT carry the demo source (`demoSources`) to Postgres —
 * "the demo foreign app is demo-only per ADR 0014; if the demo is rebuilt,
 * its projection target becomes an ordinary PG table created alongside
 * stage 7" — so with the provider unmounted the page renders the shared
 * archived state instead of hooks that would throw. The panels were removed
 * from the shell; they live on in the untouched `app/convex/` +
 * `packages/json-cms/` reference trees and the `demo/` fixtures.
 */
function DashboardPage() {
  return (
    <ArchivedConvexSurface
      description="This dashboard was the bound-datasets demo's foreign-source editor — a demo-only surface over the pre-migration Convex tables. The demo source is not carried to Postgres (issue #206)."
      homeTo="/datasets"
      title="The demo source dashboard is archived in this build"
    />
  );
}

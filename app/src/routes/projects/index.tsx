import { createFileRoute } from "@tanstack/react-router";

import { PgProjectsBrowser } from "#/features/publishing";

/**
 * The project browser (roadmap 7a, #102; lifecycle doc §3): the working
 * layer's front door. Projects are the draft-side containers where
 * import/create lands; the datasets browser remains the materialized
 * catalog.
 *
 * Stage 7 (issue #206) collapsed the §14.6 split: the pre-migration Convex
 * projects page (its `api.publishing.projects.*` reads/mutations through the
 * light-query bridge and `useConvexAuth` sign-in branch) is archived with
 * the provider, so the route renders the Postgres projects browser only.
 * The Convex page was removed from the shell; it lives on in the untouched
 * `app/convex/` + `packages/json-cms/` reference trees.
 */
export const Route = createFileRoute("/projects/")({
  component: ProjectsRoutePage,
});

function ProjectsRoutePage() {
  return <PgProjectsBrowser />;
}

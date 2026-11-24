import { createFileRoute } from "@tanstack/react-router";

import { PgProjectsBrowser } from "#/features/publishing";

/**
 * The project browser (roadmap 7a, #102; lifecycle doc §3): the working
 * layer's front door. Projects are the draft-side containers where
 * import/create lands; the datasets browser remains the materialized
 * catalog.
 */
export const Route = createFileRoute("/projects/")({
  component: ProjectsRoutePage,
});

function ProjectsRoutePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <PgProjectsBrowser />
    </main>
  );
}

import { createFileRoute } from "@tanstack/react-router";

import { PgDerivedDatasetPage } from "#/features/publishing";

/** One derived dataset's joined-table view ([remedies 3], #289): the spec's output with its match stats, opened from the catalog's Derived section. */
export const Route = createFileRoute("/projects/$projectId/derived/$derivedId")({
  component: PgDerivedDatasetPage,
});

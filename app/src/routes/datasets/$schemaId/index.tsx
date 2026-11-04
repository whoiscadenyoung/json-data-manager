import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PostgresDatasetPage } from "#/features/datasets";
import { isPostgresDatasetId } from "@/lib/dataset-source";

const entryPanelSearchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
  // Active tab ("overview" is the default and deliberately absent from the URL).
  // Stage 9 (#105) added "analyze" — the SQL escape hatch beside "transform".
  view: z.enum(["overview", "entries", "history", "structure", "transform", "analyze"]).optional(),
  // The Postgres table's server-driven state (design doc §8.4): the search
  // box, the sort, and the filter-menu rows ride the URL and drive the
  // `search_entries` RPC.
  q: z.string().optional(),
  sort: z.string().optional(),
  filters: z.string().optional(),
});

export const Route = createFileRoute("/datasets/$schemaId/")({
  component: SchemaDetailPage,
  validateSearch: entryPanelSearchSchema,
});

/**
 * The dataset detail page. Transitional split (design doc §14), collapsed by
 * the stage-7 disconnect (issue #206): the id says where the dataset was
 * created — Postgres-native datasets (uuid ids, minted by the stage-1
 * create flow) mount the store-backed page; every pre-migration Convex
 * dataset renders the shared ARCHIVED state instead of its old Convex
 * surface, whose `convex/react` hooks would throw against the unmounted
 * provider. The pre-disconnect Convex body (`SchemaDetailBody` and its
 * helpers — the seam subscriptions, the convex mutations, the TanStack
 * convexQuery bridge reads) was removed from the shell with it; the
 * untouched `app/convex/` + `packages/json-cms/` trees remain the reference.
 */
function SchemaDetailPage() {
  const { schemaId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate();
  if (isPostgresDatasetId(schemaId)) {
    return (
      <PostgresDatasetPage
        onPatchSearch={(patch) => {
          // Merge form, never replace — the ui-polish rule: an object-form
          // search silently drops the page's other params (?view=, ?panel=).
          void navigate({ search: (prev) => ({ ...prev, ...patch }) });
        }}
        schemaId={schemaId}
        search={{
          entryId: search.entryId,
          filters: search.filters,
          panel: search.panel,
          q: search.q,
          sort: search.sort,
          view: search.view,
        }}
      />
    );
  }
  return <ArchivedConvexSurface />;
}

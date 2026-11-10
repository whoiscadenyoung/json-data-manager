import { useQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PostgresDatasetPage } from "#/features/datasets";
import { isPostgresDatasetId } from "@/lib/dataset-source";
import * as datasetsStore from "@/lib/store/datasets";
import * as projectsStore from "@/lib/store/projects";

const entryPanelSearchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
  // Active tab ("overview" is the default and deliberately absent from the URL).
  // Stage 9 (#105) added "analyze" — the SQL escape hatch.
  view: z.enum(["overview", "entries", "history", "structure", "analyze"]).optional(),
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
    return <StandaloneDataset schemaId={schemaId} search={search} navigate={navigate} />;
  }
  return <ArchivedConvexSurface />;
}

type DatasetSearch = z.infer<typeof entryPanelSearchSchema>;

/**
 * An unpublished dataset owned by a project lives in that project (issue
 * #271): the standalone route forwards it into the project shell. Published
 * datasets stay here — this is their public view (the shell links to it).
 */
function StandaloneDataset({
  navigate,
  schemaId,
  search,
}: {
  navigate: ReturnType<typeof Route.useNavigate>;
  schemaId: string;
  search: DatasetSearch;
}) {
  const datasetQuery = useQuery(datasetsStore.getQueryOptions({ datasetId: schemaId })),
    ownerQuery = useQuery(projectsStore.ownerOfArtifactQueryOptions({ artifactId: schemaId })),
    dataset = datasetQuery.data;
  if (
    dataset !== null &&
    dataset !== undefined &&
    dataset.lifecycle === "draft" &&
    ownerQuery.data !== null &&
    ownerQuery.data !== undefined
  ) {
    return (
      <Navigate
        params={{ projectId: ownerQuery.data, schemaId }}
        replace
        search={search}
        to="/projects/$projectId/datasets/$schemaId"
      />
    );
  }
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

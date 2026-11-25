import { useQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { DatasetPage } from "#/features/datasets";
import * as datasetsStore from "@/lib/store/datasets";
import * as projectsStore from "@/lib/store/projects";

const entryPanelSearchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
  // Active tab ("overview" is the default and deliberately absent from the URL).
  view: z.enum(["overview", "entries", "history", "related", "structure"]).optional(),
  // The Postgres table's server-driven state (design doc §8.4): the search
  // box, the sort, and the filter-menu rows ride the URL and drive the
  // `search_entries` RPC.
  q: z.string().optional(),
  sort: z.string().optional(),
  filters: z.string().optional(),
});

export const Route = createFileRoute("/datasets/$datasetId/")({
  component: SchemaDetailPage,
  validateSearch: entryPanelSearchSchema,
});

/** The dataset detail page. */
function SchemaDetailPage() {
  const { datasetId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate();
  return <StandaloneDataset datasetId={datasetId} search={search} navigate={navigate} />;
}

type DatasetSearch = z.infer<typeof entryPanelSearchSchema>;

/**
 * An unpublished dataset owned by a project lives in that project (issue
 * #271): the standalone route forwards it into the project shell. Published
 * datasets stay here — this is their public view (the shell links to it).
 */
function StandaloneDataset({
  navigate,
  datasetId,
  search,
}: {
  navigate: ReturnType<typeof Route.useNavigate>;
  datasetId: string;
  search: DatasetSearch;
}) {
  const datasetQuery = useQuery(datasetsStore.getQueryOptions({ datasetId: datasetId })),
    ownerQuery = useQuery(projectsStore.ownerOfArtifactQueryOptions({ artifactId: datasetId })),
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
        params={{ projectId: ownerQuery.data, datasetId }}
        replace
        search={search}
        to="/projects/$projectId/datasets/$datasetId"
      />
    );
  }
  return (
    <DatasetPage
      onPatchSearch={(patch) => {
        // Merge form, never replace — the ui-polish rule: an object-form
        // search silently drops the page's other params (?view=, ?panel=).
        void navigate({ search: (prev) => ({ ...prev, ...patch }) });
      }}
      datasetId={datasetId}
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

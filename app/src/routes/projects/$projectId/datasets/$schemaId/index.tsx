import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { DatasetProjectContext, PostgresDatasetPage } from "#/features/datasets";
import { isPostgresDatasetId } from "@/lib/dataset-source";

// Same search contract as the standalone /datasets/$schemaId page.
const searchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
  view: z.enum(["overview", "entries", "history", "structure", "analyze"]).optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  filters: z.string().optional(),
});

/**
 * The dataset page inside the project shell (issue #271): the same page as
 * `/datasets/$schemaId`, rendered in the shell's content area with every link
 * it emits kept inside the project (via DatasetProjectContext).
 */
export const Route = createFileRoute("/projects/$projectId/datasets/$schemaId/")({
  component: ProjectDatasetPage,
  validateSearch: searchSchema,
});

function ProjectDatasetPage() {
  const { projectId, schemaId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate();
  if (!isPostgresDatasetId(schemaId)) {
    return <ArchivedConvexSurface />;
  }
  return (
    <DatasetProjectContext.Provider value={projectId}>
      <PostgresDatasetPage
        onPatchSearch={(patch) => {
          void navigate({ search: (prev) => ({ ...prev, ...patch }) });
        }}
        schemaId={schemaId}
        search={search}
      />
    </DatasetProjectContext.Provider>
  );
}

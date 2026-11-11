import { createFileRoute } from "@tanstack/react-router";

import { LineageGraph } from "#/features/view-graphs";

/** Lineage section of the project shell (views initiative #304): how the catalog fits together. */
export const Route = createFileRoute("/projects/$projectId/lineage")({
  component: LineagePage,
});

function LineagePage() {
  const { projectId } = Route.useParams();
  return (
    <div className="flex h-[calc(100svh-8rem)] min-h-[28rem] flex-col gap-3 p-4">
      <div>
        <h1 className="text-lg font-semibold">Lineage</h1>
        <p className="text-sm text-muted-foreground">
          Datasets, views, maps, layers and apps in this project, and what feeds what. Click a node
          to open it.
        </p>
      </div>
      <LineageGraph className="min-h-0" projectId={projectId} />
    </div>
  );
}

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@caden/ui/components/empty";
import { cn } from "@caden/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { lineageQueryOptions } from "#/lib/store/lineage";

import { buildLineageGraph } from "../lib/lineage-graph";
import { lineageNodeHref } from "../lib/node-href";
import { GraphSkeleton } from "./graph-view";
import { LineageGraphView } from "./lineage-graph-view";

/**
 * The project's catalog lineage (design §9): datasets, views, maps, layers
 * and apps with view inputs (solid), relations (dashed) and consumers.
 * Fetches through the store under the viewer's RLS; clicking a node opens it.
 */
export function LineageGraph({ projectId, className }: { projectId: string; className?: string }) {
  const router = useRouter();
  const query = useQuery(lineageQueryOptions({ projectId }));

  if (query.isError) {
    return (
      <Empty className="min-h-64 border" role="alert">
        <EmptyHeader>
          <EmptyTitle>Could not load the lineage</EmptyTitle>
          <EmptyDescription>{query.error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (query.data === undefined) {
    return (
      <div className={cn("min-h-96 flex-1", className)}>
        <GraphSkeleton />
      </div>
    );
  }
  const graph = buildLineageGraph(query.data);
  return (
    <LineageGraphView
      className={className}
      graph={graph}
      onOpen={(node) => {
        const href = lineageNodeHref(projectId, node);
        if (href !== null) {
          router.history.push(href);
        }
      }}
    />
  );
}

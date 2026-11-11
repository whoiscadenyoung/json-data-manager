import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@caden/ui/components/empty";
import { cn } from "@caden/ui/lib/utils";

import type { Graph, GraphNode } from "../lib/graph-types";
import { GraphView } from "./graph-view";

function LegendLine({ dashed }: { dashed?: boolean }) {
  return (
    <svg aria-hidden="true" className="h-2 w-8 text-muted-foreground" viewBox="0 0 32 8">
      <line
        stroke="currentColor"
        strokeDasharray={dashed === true ? "6 4" : undefined}
        strokeWidth="2"
        x1="0"
        x2="32"
        y1="4"
        y2="4"
      />
    </svg>
  );
}

/** What the edge styles and node markers mean. */
export function LineageLegend({ className }: { className?: string }) {
  return (
    <ul
      aria-label="Legend"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <li className="flex items-center gap-1.5">
        <LegendLine /> View input or consumer
      </li>
      <li className="flex items-center gap-1.5">
        <LegendLine dashed /> Relation
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded-sm border border-dashed border-primary" /> Stale view
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-3 w-5 rounded-sm border border-destructive" /> Last run failed
      </li>
    </ul>
  );
}

function isEmpty(graph: Graph): boolean {
  return graph.nodes.length === 0;
}

/** The lineage canvas for an already-built graph (also what the component test renders). */
export function LineageGraphView({
  graph,
  onOpen,
  className,
}: {
  graph: Graph;
  onOpen?: (node: GraphNode) => void;
  className?: string;
}) {
  if (isEmpty(graph)) {
    return (
      <Empty className="min-h-64 border">
        <EmptyHeader>
          <EmptyTitle>Nothing to show yet</EmptyTitle>
          <EmptyDescription>
            Add datasets, views, maps or apps to this project and how they connect appears here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className={cn("flex min-h-96 flex-1 flex-col gap-2", className)}>
      <div className="min-h-80 flex-1">
        <GraphView ariaLabel="Catalog lineage graph" graph={graph} onNodeClick={onOpen} />
      </div>
      <LineageLegend />
    </div>
  );
}

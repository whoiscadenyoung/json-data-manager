import { Skeleton } from "@caden/ui/components/skeleton";
import { cn } from "@caden/ui/lib/utils";
import { Suspense, lazy, useSyncExternalStore } from "react";

import type { GraphViewImplProps } from "./graph-view-impl";

const GraphViewImpl = lazy(async () => {
  const mod = await import("./graph-view-impl");
  return { default: mod.GraphViewImpl };
});

const subscribe = () => () => {};

// SSR-safe "are we on the client yet?" (the json-editor pattern): false on the
// server and during hydration, true afterwards.
function useIsClient() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export function GraphSkeleton({ className }: { className?: string }) {
  return (
    <Skeleton className={cn("h-full w-full rounded-lg", className)} data-testid="graph-skeleton" />
  );
}

/**
 * Client-only wrapper around the React Flow canvas. @xyflow/react measures the
 * DOM and elkjs ships a worker shim, neither of which belongs in the SSR
 * bundle, so the real implementation loads by dynamic import behind a mount
 * check (the same shape as the CodeMirror JSON editor). The parent must give
 * it a height.
 */
export function GraphView(props: GraphViewImplProps) {
  const isClient = useIsClient();
  if (!isClient) {
    return <GraphSkeleton className={props.className} />;
  }
  return (
    <Suspense fallback={<GraphSkeleton className={props.className} />}>
      <GraphViewImpl {...props} />
    </Suspense>
  );
}

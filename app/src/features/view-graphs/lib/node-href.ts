import type { GraphNode } from "./graph-types";

/**
 * Where clicking a lineage node goes, or null when it goes nowhere (layers
 * have no page of their own; unreadable datasets have nothing to open). The
 * view route is created by the view editor (#301).
 */
export function lineageNodeHref(projectId: string, node: GraphNode): string | null {
  if (node.entityId === undefined || node.unavailable === true) {
    return null;
  }
  const base = `/projects/${projectId}`;
  switch (node.kind) {
    case "dataset":
      return `${base}/datasets/${node.entityId}`;
    case "view":
      return `${base}/views/${node.entityId}`;
    case "map":
      return `${base}/maps/${node.entityId}`;
    case "app":
      return `${base}/apps/${node.entityId}/edit`;
    default:
      return null;
  }
}

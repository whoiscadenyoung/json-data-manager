import { Link } from "@tanstack/react-router";
import { Waypoints } from "lucide-react";

import { relationPhrase, type RelationEnd } from "@/lib/relation-phrases";

/**
 * A catalog row's link badge: the count, with the linked datasets in its
 * tooltip. Clicking it opens the dataset's Related tab, where links are
 * managed. Renders nothing for a dataset with no links.
 */
export function RelationBadge({
  datasetId,
  ends,
  projectId,
  titleOf,
}: {
  datasetId: string;
  ends: readonly RelationEnd[];
  projectId: string;
  titleOf: (datasetId: string) => string;
}) {
  if (ends.length === 0) {
    return null;
  }
  const label = `${ends.length} ${ends.length === 1 ? "link" : "links"}`;
  return (
    <Link
      aria-label={`${label}: open the Related tab`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
      params={{ projectId, schemaId: datasetId }}
      search={{ view: "related" }}
      title={ends.map((end) => relationPhrase(end, titleOf)).join("\n")}
      to="/projects/$projectId/datasets/$schemaId"
    >
      <Waypoints className="h-3 w-3" />
      {label}
    </Link>
  );
}

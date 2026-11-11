import { Popover, PopoverContent, PopoverTrigger } from "@caden/ui/components/popover";
import { Link } from "@tanstack/react-router";
import { Waypoints } from "lucide-react";

import { relationPhrase, type RelationEnd } from "@/lib/relation-phrases";

/**
 * A catalog row's relation badge (issue #294): the count, and on click the
 * peek list ("Related to FY23 IG Project Corridors via UEI") with a link to
 * the project's Lineage graph, which draws the same relations as dashed
 * edges. Renders nothing for a dataset with no relations.
 */
export function RelationBadge({
  ends,
  projectId,
  titleOf,
}: {
  ends: readonly RelationEnd[];
  projectId: string;
  titleOf: (datasetId: string) => string;
}) {
  if (ends.length === 0) {
    return null;
  }
  const label = `${ends.length} ${ends.length === 1 ? "relation" : "relations"}`;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${label} — show which datasets this one relates to`}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
      >
        <Waypoints className="h-3 w-3" />
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <ul className="flex flex-col gap-1.5 text-sm">
          {ends.map((end) => (
            <li key={end.relationId}>{relationPhrase(end, titleOf)}</li>
          ))}
        </ul>
        <Link
          className="mt-2 inline-block text-xs text-primary hover:underline"
          params={{ projectId }}
          to="/projects/$projectId/lineage"
        >
          See them in Lineage
        </Link>
      </PopoverContent>
    </Popover>
  );
}

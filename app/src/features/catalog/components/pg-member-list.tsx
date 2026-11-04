import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Trash2, Ungroup } from "lucide-react";

import type { DatasetSummaryRow } from "#/lib/store/datasets";
import type { GroupRow } from "#/lib/store/groups";

import { PgDatasetTagsWithCount } from "./pg-dataset-tags";

/**
 * The Postgres member-dataset list shared by the collection and group pages —
 * the core `DatasetList`'s PG edition. Rows carry the same type tags +
 * trigger-maintained counts as the browser's cards (ui-polish info parity,
 * tags stacked above the title on these compact rows) and the same
 * membership actions, adapted to the PG writes.
 */
export function PgMemberList({
  datasets,
  groups,
  collectionId,
  emptyLabel,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  datasets: DatasetSummaryRow[];
  /** Every PG group, for the move-to-group submenu. */
  groups: GroupRow[];
  /** Present on collection pages: rows offer "Remove from collection" (the direct membership delete; a group member's membership lives with its group). */
  collectionId?: string;
  emptyLabel: string;
  onMoveToGroup: (dataset: DatasetSummaryRow, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: DatasetSummaryRow) => void;
}) {
  if (datasets.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {datasets.map((dataset) => {
        const otherGroups = groups.filter((group) => group.id !== dataset.groupId);
        return (
          <li
            key={dataset.id}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
          >
            <Link
              to="/datasets/$schemaId"
              params={{ schemaId: dataset.id }}
              className="min-w-0 flex-1"
            >
              <div className="mb-1">
                <PgDatasetTagsWithCount dataset={dataset} />
              </div>
              <p className="truncate text-sm font-medium">{dataset.title}</p>
              <p className="truncate text-xs text-muted-foreground">{dataset.description}</p>
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" aria-label="Dataset actions" />}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {otherGroups.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {otherGroups.map((group) => (
                        <DropdownMenuItem
                          key={group.id}
                          onClick={() => {
                            onMoveToGroup(dataset, group.id);
                          }}
                        >
                          {group.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {dataset.groupId !== null && (
                  <DropdownMenuItem
                    onClick={() => {
                      onMoveToGroup(dataset, null);
                    }}
                  >
                    <Ungroup className="h-3.5 w-3.5" />
                    Remove from group
                  </DropdownMenuItem>
                )}
                {collectionId !== undefined && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        onRemoveFromCollection(dataset);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove from collection
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}

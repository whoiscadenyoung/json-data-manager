import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { MoreHorizontal, Trash2, Ungroup } from "lucide-react";

import { DatasetTypeTags } from "#/components/dataset-type-tags";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { api } from "#convex/_generated/api";

export type GroupDoc = FunctionReturnType<typeof api.groups.list>[number];
export type Dataset = FunctionReturnType<typeof api.schemas.list>[number];

/** Row/feature count shown next to a dataset's tags, or undefined when unknown. Geospatial datasets carry an exactly-maintained feature count on the schema doc itself; regular datasets count rows, which only some host pages have fetched. */
function datasetCountLabel(
  dataset: Dataset,
  entryCounts: Map<string, number> | undefined,
): string | undefined {
  if (dataset.kind === "geospatial") {
    return dataset.featureCount === undefined
      ? undefined
      : `${dataset.featureCount} ${dataset.featureCount === 1 ? "feature" : "features"}`;
  }
  if (entryCounts === undefined) {
    return undefined;
  }
  const rowCount = entryCounts.get(dataset._id) ?? 0;
  return `${rowCount} ${rowCount === 1 ? "row" : "rows"}`;
}

function DatasetRow({
  dataset,
  groups,
  entryCounts,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  dataset: Dataset;
  groups: GroupDoc[];
  entryCounts: Map<string, number> | undefined;
  onMoveToGroup: (dataset: Dataset, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: Dataset) => void;
}) {
  const otherGroups = groups.filter((group) => group._id !== dataset.groupId),
    countLabel = datasetCountLabel(dataset, entryCounts);

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <Link to="/datasets/$schemaId" params={{ schemaId: dataset._id }} className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <DatasetTypeTags dataset={dataset} />
          {countLabel && <span className="text-xs text-muted-foreground">{countLabel}</span>}
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
                    key={group._id}
                    onClick={() => {
                      onMoveToGroup(dataset, group._id);
                    }}
                  >
                    {group.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {dataset.groupId !== undefined && (
            <DropdownMenuItem
              onClick={() => {
                onMoveToGroup(dataset, null);
              }}
            >
              <Ungroup className="h-3.5 w-3.5" />
              Remove from group
            </DropdownMenuItem>
          )}
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
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function DatasetList({
  datasets,
  groups,
  entryCounts,
  emptyLabel,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  datasets: Dataset[];
  groups: GroupDoc[];
  /** Optional schemaId → row-count map for regular datasets' "N rows" labels — host pages that already fetched entries (e.g. the group page) pass it; without it those labels are simply omitted. */
  entryCounts?: Map<string, number>;
  emptyLabel: string;
  onMoveToGroup: (dataset: Dataset, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: Dataset) => void;
}) {
  if (datasets.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {datasets.map((dataset) => (
        <DatasetRow
          key={dataset._id}
          dataset={dataset}
          groups={groups}
          entryCounts={entryCounts}
          onMoveToGroup={onMoveToGroup}
          onRemoveFromCollection={onRemoveFromCollection}
        />
      ))}
    </ul>
  );
}

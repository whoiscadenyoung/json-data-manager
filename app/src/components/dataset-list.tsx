import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { MoreHorizontal, Trash2, Ungroup } from "lucide-react";

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

function DatasetRow({
  dataset,
  groups,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  dataset: Dataset;
  groups: GroupDoc[];
  onMoveToGroup: (dataset: Dataset, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: Dataset) => void;
}) {
  const otherGroups = groups.filter((group) => group._id !== dataset.groupId);

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <Link to="/datasets/$schemaId" params={{ schemaId: dataset._id }} className="min-w-0 flex-1">
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
  emptyLabel,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  datasets: Dataset[];
  groups: GroupDoc[];
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
          onMoveToGroup={onMoveToGroup}
          onRemoveFromCollection={onRemoveFromCollection}
        />
      ))}
    </ul>
  );
}

import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, FolderOpen, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DatasetTypeTags } from "#/components/dataset-type-tags";
import type { DatasetSummary } from "#/components/dataset-type-tags";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import type { MembershipRow } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

type CollectionDoc = FunctionReturnType<typeof api.collections.list>[number];
type GroupDoc = FunctionReturnType<typeof api.groups.list>[number];

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** True when `text`/`description` contains the (already normalized) search. */
function matchesSearch(normalized: string, text: string, description?: string): boolean {
  return (
    text.toLowerCase().includes(normalized) ||
    (description !== undefined && description.toLowerCase().includes(normalized))
  );
}

/** Groups the datasets by `groupId` (order preserved). */
function groupMembersByGroup(datasets: DatasetSummary[]): globalThis.Map<string, DatasetSummary[]> {
  const byGroup = new globalThis.Map<string, DatasetSummary[]>();
  for (const dataset of datasets) {
    if (dataset.groupId !== undefined) {
      const members = byGroup.get(dataset.groupId);
      if (members !== undefined) {
        members.push(dataset);
      } else {
        byGroup.set(dataset.groupId, [dataset]);
      }
    }
  }
  return byGroup;
}

/** Candidate groups (with search-filtered members) and standalone candidate datasets, built once per render. */
function buildCandidates(
  groups: GroupDoc[],
  datasets: DatasetSummary[],
  collectionId: string,
  normalized: string,
): {
  groupItems: Array<{ group: GroupDoc; members: DatasetSummary[]; inThisCollection: boolean }>;
  datasetItems: DatasetSummary[];
} {
  const byGroup = groupMembersByGroup(datasets),
    groupItems = groups
      .map((group) => {
        const members = byGroup.get(group._id) ?? [],
          groupMatches =
            normalized !== "" && matchesSearch(normalized, group.name, group.description),
          visibleMembers =
            normalized === "" || groupMatches
              ? members
              : members.filter((member) =>
                  matchesSearch(normalized, member.title, member.description),
                );
        return {
          group,
          members: visibleMembers,
          inThisCollection: group.collectionId === collectionId,
          visible: groupMatches || visibleMembers.length > 0,
        };
      })
      .filter((item) => item.visible);
  return {
    groupItems,
    datasetItems: datasets.filter(
      (dataset) =>
        dataset.groupId === undefined &&
        (normalized === "" || matchesSearch(normalized, dataset.title, dataset.description)),
    ),
  };
}

/** One candidate group: header row with an Add action, member datasets nested beneath — the datasets browser's group presentation, shrunk into a picker row. */
function GroupCandidateRow({
  group,
  members,
  detail,
  inThisCollection,
  pendingKey,
  onAdd,
}: {
  group: GroupDoc;
  members: DatasetSummary[];
  detail: string;
  inThisCollection: boolean;
  pendingKey: string | undefined;
  onAdd: (group: GroupDoc) => void;
}) {
  return (
    <li className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{group.name}</p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
        {inThisCollection ? (
          <Badge variant="secondary">
            <Check />
            Added
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={pendingKey !== undefined}
            onClick={() => {
              onAdd(group);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {pendingKey === group._id ? "Adding…" : "Add"}
          </Button>
        )}
      </div>
      {members.length > 0 && (
        <ul className="border-t bg-muted/20">
          {members.map((member) => (
            <li
              key={member._id}
              className="flex items-center gap-2 border-b px-3 py-1.5 pl-8 last:border-b-0"
            >
              <span className="flex shrink-0 items-center gap-1">
                <DatasetTypeTags dataset={member} />
              </span>
              <p className="truncate text-sm">{member.title}</p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One candidate dataset that isn't in a group — a flat row with an Add action. */
function DatasetCandidateRow({
  dataset,
  added,
  pendingKey,
  onAdd,
}: {
  dataset: DatasetSummary;
  added: boolean;
  pendingKey: string | undefined;
  onAdd: (dataset: DatasetSummary) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex shrink-0 items-center gap-1">
          <DatasetTypeTags dataset={dataset} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{dataset.title}</p>
          {dataset.description && (
            <p className="truncate text-xs text-muted-foreground">{dataset.description}</p>
          )}
        </div>
      </div>
      {added ? (
        <Badge variant="secondary">
          <Check />
          Added
        </Badge>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={pendingKey !== undefined}
          onClick={() => {
            onAdd(dataset);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {pendingKey === dataset._id ? "Adding…" : "Add"}
        </Button>
      )}
    </li>
  );
}

/**
 * Side panel for filling a collection, presented like the datasets browser:
 * groups appear as single units (their member datasets nested beneath) and
 * datasets without a group as flat rows. Adding a group drops the whole
 * group in as one unit — its member datasets come along, and datasets later
 * added to the group flow through (the group is the member, not its rows).
 * A group already living in another collection can still be added; it moves.
 */
export function CollectionAddSheet({
  collectionId,
  collectionName,
  collections,
  groups,
  datasets,
  memberships,
  open,
  onOpenChange,
}: {
  collectionId: string;
  collectionName: string;
  collections: CollectionDoc[];
  groups: GroupDoc[];
  datasets: DatasetSummary[];
  memberships: MembershipRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addSchemaToCollection = useMutation(api.collections.addSchemaToCollection),
    setGroupCollection = useMutation(api.groups.setCollection),
    [search, setSearch] = useState(""),
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    handleAddDataset = async (dataset: DatasetSummary) => {
      setPendingKey(dataset._id);
      try {
        await addSchemaToCollection({ collectionId, schemaId: dataset._id });
        toast.success(`Added "${dataset.title}" to "${collectionName}".`);
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to add dataset."));
      } finally {
        setPendingKey(undefined);
      }
    },
    handleAddGroup = async (group: GroupDoc) => {
      setPendingKey(group._id);
      try {
        await setGroupCollection({ collectionId, groupId: group._id });
        toast.success(
          group.collectionId === undefined
            ? `Added "${group.name}" to "${collectionName}".`
            : `Added "${group.name}" to "${collectionName}" (moved from its previous collection).`,
        );
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to add group."));
      } finally {
        setPendingKey(undefined);
      }
    };

  const normalizedSearch = search.trim().toLowerCase(),
    collectionNameById = (id: string) => {
      const collection = collections.find((entry) => entry._id === id);
      return collection ? collection.name : "another collection";
    },
    directMemberIds = new Set(
      memberships
        .filter((membership) => membership.collectionId === collectionId)
        .map((membership) => membership.schemaId),
    );

  // Group candidates mirror the browser's filtering: a group matches the
  // search when its own name/description matches (then ALL its members
  // show), or when any member matches (then just those members show).
  const { groupItems, datasetItems } = buildCandidates(
      groups,
      datasets,
      collectionId,
      normalizedSearch,
    ),
    nothingAddedYet =
      groups.every((group) => group.collectionId !== collectionId) && directMemberIds.size === 0;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to collection</SheetTitle>
          <SheetDescription>
            Add datasets or whole groups to "{collectionName}". A group is added as one unit — its
            datasets come along.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              placeholder="Search datasets and groups…"
              className="pl-7"
            />
          </div>

          {groupItems.length === 0 && datasetItems.length === 0 ? (
            <Empty className="min-h-32 border">
              <EmptyTitle>No matches</EmptyTitle>
              <EmptyDescription>
                {groups.length === 0 && datasets.length === 0
                  ? "Create datasets or groups first, then add them here."
                  : "No datasets or groups match your search."}
              </EmptyDescription>
            </Empty>
          ) : (
            <>
              {groupItems.length > 0 && (
                <section className="flex flex-col gap-1" aria-label="Groups">
                  <h3 className="text-xs font-medium text-muted-foreground">Groups</h3>
                  <ul className="flex flex-col gap-1.5">
                    {groupItems.map((item) => (
                      <GroupCandidateRow
                        key={item.group._id}
                        group={item.group}
                        members={item.members}
                        inThisCollection={item.inThisCollection}
                        pendingKey={pendingKey}
                        detail={`${item.group.collectionId === undefined ? "Standalone" : `In ${collectionNameById(item.group.collectionId)}`} · ${
                          item.members.length === 1
                            ? "1 dataset"
                            : `${item.members.length} datasets`
                        }`}
                        onAdd={(group) => {
                          void handleAddGroup(group);
                        }}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {datasetItems.length > 0 && (
                <section className="flex flex-col gap-1" aria-label="Datasets">
                  <h3 className="text-xs font-medium text-muted-foreground">Datasets</h3>
                  <ul className="flex flex-col gap-1">
                    {datasetItems.map((dataset) => (
                      <DatasetCandidateRow
                        key={dataset._id}
                        dataset={dataset}
                        added={directMemberIds.has(dataset._id)}
                        pendingKey={pendingKey}
                        onAdd={(target) => {
                          void handleAddDataset(target);
                        }}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}

          {normalizedSearch === "" &&
            nothingAddedYet &&
            (groupItems.length > 0 || datasetItems.length > 0) && (
              <p className="text-xs text-muted-foreground">
                Items already in this collection show an "Added" badge.
              </p>
            )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

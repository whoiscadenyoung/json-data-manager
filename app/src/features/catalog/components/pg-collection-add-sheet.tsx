import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQueryClient } from "@tanstack/react-query";
import { Check, FolderOpen, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";
import type { GroupRow } from "#/lib/store/groups";

import { PgDatasetTagsWithCount } from "./pg-dataset-tags";

/**
 * Side panel for filling a Postgres collection, presented like the datasets
 * browser: groups appear as single units (their member datasets nested
 * beneath) and datasets without a group as flat rows. Adding a group drops
 * the whole group in as one unit — its member datasets come along, and
 * datasets later added to the group flow through (the group is the member,
 * not its rows). A group already living in another collection can still be
 * added; it moves (component parity with `api.cms.groups.setCollection`).
 */

/** True when `title`/`description` contains the (already normalized) search. */
function matchesSearch(normalized: string, text: string, description: string | null): boolean {
  return (
    text.toLowerCase().includes(normalized) ||
    (description !== null && description.toLowerCase().includes(normalized))
  );
}

/** Groups the datasets by `groupId` (order preserved). */
function groupMembersByGroup(
  datasets: DatasetSummaryRow[],
): globalThis.Map<string, DatasetSummaryRow[]> {
  const byGroup = new globalThis.Map<string, DatasetSummaryRow[]>();
  for (const dataset of datasets) {
    if (dataset.groupId !== null) {
      const members = byGroup.get(dataset.groupId);
      if (members === undefined) {
        byGroup.set(dataset.groupId, [dataset]);
      } else {
        members.push(dataset);
      }
    }
  }
  return byGroup;
}

/** Candidate groups (with search-filtered members) and standalone candidate datasets. */
function buildCandidates(
  groups: GroupRow[],
  datasets: DatasetSummaryRow[],
  collectionId: string,
  normalized: string,
): {
  datasetItems: DatasetSummaryRow[];
  groupItems: Array<{
    group: GroupRow;
    inThisCollection: boolean;
    members: DatasetSummaryRow[];
    visible: boolean;
  }>;
} {
  const byGroup = groupMembersByGroup(datasets),
    groupItems = groups
      .map((group) => {
        const members = byGroup.get(group.id) ?? [],
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
          inThisCollection: group.collectionId === collectionId,
          members: visibleMembers,
          visible: groupMatches || visibleMembers.length > 0,
        };
      })
      .filter((item) => item.visible);
  return {
    groupItems,
    datasetItems: datasets.filter(
      (dataset) =>
        dataset.groupId === null &&
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
  group: GroupRow;
  members: DatasetSummaryRow[];
  detail: string;
  inThisCollection: boolean;
  pendingKey: string | undefined;
  onAdd: (group: GroupRow) => void;
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
            {pendingKey === group.id ? "Adding…" : "Add"}
          </Button>
        )}
      </div>
      {members.length > 0 && (
        <ul className="border-t bg-muted/20">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-2 border-b px-3 py-1.5 pl-8 last:border-b-0"
            >
              <PgDatasetTagsWithCount dataset={member} />
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
  added,
  dataset,
  pendingKey,
  onAdd,
}: {
  added: boolean;
  dataset: DatasetSummaryRow;
  pendingKey: string | undefined;
  onAdd: (dataset: DatasetSummaryRow) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <PgDatasetTagsWithCount dataset={dataset} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{dataset.title}</p>
          {dataset.description !== null && (
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
          {pendingKey === dataset.id ? "Adding…" : "Add"}
        </Button>
      )}
    </li>
  );
}

export function PgCollectionAddSheet({
  collectionId,
  collectionName,
  groups,
  datasets,
  memberDatasetIds,
  open,
  resolveCollectionName,
  onOpenChange,
}: {
  collectionId: string;
  collectionName: string;
  groups: GroupRow[];
  datasets: DatasetSummaryRow[];
  /** Ids of the collection's direct dataset members — those rows read "Added" instead of offering a duplicate add. */
  memberDatasetIds: Set<string>;
  open: boolean;
  /** Names a group's CURRENT collection for its detail line (the host page holds the collections read). */
  resolveCollectionName: (collectionId: string) => string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient(),
    [search, setSearch] = useState(""),
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    normalizedSearch = search.trim().toLowerCase(),
    handleAddDataset = async (dataset: DatasetSummaryRow) => {
      setPendingKey(dataset.id);
      try {
        await collectionsStore.addToCollection({ collectionId, datasetId: dataset.id });
        void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
        toast.success(`Added "${dataset.title}" to "${collectionName}".`);
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to add dataset."));
      } finally {
        setPendingKey(undefined);
      }
    },
    handleAddGroup = async (group: GroupRow) => {
      setPendingKey(group.id);
      try {
        await groupsStore.setCollection({ collectionId, groupId: group.id });
        void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
        void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
        toast.success(
          group.collectionId === null
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

  const { groupItems, datasetItems } = buildCandidates(
    groups,
    datasets,
    collectionId,
    normalizedSearch,
  );

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
                  ? "Create Postgres datasets or groups first, then add them here."
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
                        key={item.group.id}
                        group={item.group}
                        members={item.members}
                        inThisCollection={item.inThisCollection}
                        pendingKey={pendingKey}
                        detail={`${item.group.collectionId === null ? "Standalone" : `In ${resolveCollectionName(item.group.collectionId)}`} · ${
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
                        key={dataset.id}
                        dataset={dataset}
                        added={memberDatasetIds.has(dataset.id)}
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
        </div>
      </SheetContent>
    </Sheet>
  );
}

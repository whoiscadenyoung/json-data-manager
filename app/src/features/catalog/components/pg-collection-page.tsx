import { ConfirmDialog } from "@caden/json-cms/react/ui";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@caden/ui/components/breadcrumb";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyTitle } from "@caden/ui/components/empty";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import * as datasetsStore from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";
import type { GroupRow } from "#/lib/store/groups";

import { PgCollectionAddSheet } from "./pg-collection-add-sheet";
import { PgCollectionFormPanel } from "./pg-collection-form-panel";
import { PgDatasetPickerSheet } from "./pg-dataset-picker-sheet";
import { PgGroupFormPanel } from "./pg-group-form-panel";
import { PgMemberList } from "./pg-member-list";

/**
 * The Postgres edition of `/collections/$collectionId` (the route branches on
 * the id's origin): the collection's groups as single units — each with its
 * member datasets nested beneath — and the datasets joined directly that
 * don't sit in one of its groups. Membership ops are component parity
 * (many-to-many datasets, one collection per group, groups move between
 * collections); the writes ride `#/lib/store/collections` +
 * `#/lib/store/groups`.
 *
 * Absent on the PG page rather than broken: the extent map and the "Add to
 * map" sheet (the maps workstream owns PG catalog-target layer rendering —
 * the map layers' target ids can already address these collections).
 */

/** The page's Not Found card — an invisible/gone collection. */
function PgCollectionNotFoundCard() {
  return (
    <Card className="mx-auto mt-8 max-w-md py-12 text-center">
      <CardContent className="pt-6">
        <CardTitle className="mb-2">Collection Not Found</CardTitle>
        <CardDescription className="mb-4">
          The collection you're looking for doesn't exist or has been deleted.
        </CardDescription>
        <Link to="/collections">
          <Button>Back to Collections</Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/** One group-in-collection card: the group manages its member list, with add/edit/delete on the group itself. */
function PgCollectionGroupCard({
  group,
  groups,
  members,
  onAddDataset,
  onDelete,
  onEdit,
  onMoveToGroup,
  onRemoveDataset,
}: {
  group: GroupRow;
  groups: GroupRow[];
  members: DatasetSummaryRow[];
  onAddDataset: (group: GroupRow) => void;
  onDelete: (group: GroupRow) => void;
  onEdit: (group: GroupRow) => void;
  onMoveToGroup: (dataset: DatasetSummaryRow, groupId: string | null) => void;
  onRemoveDataset: (dataset: DatasetSummaryRow) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>
            <Link to="/groups/$groupId" params={{ groupId: group.id }} className="hover:underline">
              {group.name}
            </Link>
          </CardTitle>
          {group.description !== null && <CardDescription>{group.description}</CardDescription>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onAddDataset(group);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add dataset
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" aria-label="Group actions" />}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  onEdit(group);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  onDelete(group);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <PgMemberList
          datasets={members}
          groups={groups}
          emptyLabel="No datasets in this group yet."
          onMoveToGroup={onMoveToGroup}
          onRemoveFromCollection={onRemoveDataset}
        />
      </CardContent>
    </Card>
  );
}

/** The collection page's content, once the collection read has landed. */
// oxlint-disable-next-line eslint/complexity -- the page reads both stores' catalog rows and composes the store seams; ad hoc splitting risks these render paths (the same #82 phase-2 note the sibling Convex pages carry).
function PgCollectionPageBody({ collectionId }: { collectionId: string }) {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    collectionQuery = useQuery(collectionsStore.getQueryOptions({ collectionId })),
    groupsQuery = useQuery(groupsStore.listQueryOptions({ collectionId })),
    allGroupsQuery = useQuery(groupsStore.listQueryOptions()),
    allCollectionsQuery = useQuery(collectionsStore.listQueryOptions()),
    datasetsQuery = useQuery(datasetsStore.listSummariesQueryOptions()),
    membershipsQuery = useQuery(collectionsStore.listMembershipsQueryOptions()),
    [editingCollection, setEditingCollection] = useState(false),
    [pendingDeleteCollection, setPendingDeleteCollection] = useState(false),
    [groupFormOpen, setGroupFormOpen] = useState(false),
    [editingGroup, setEditingGroup] = useState<GroupRow | undefined>(),
    [pendingDeleteGroup, setPendingDeleteGroup] = useState<GroupRow | undefined>(),
    [addDatasetTarget, setAddDatasetTarget] = useState<"collection" | GroupRow | undefined>(),
    collection = collectionQuery.data,
    groups = groupsQuery.data ?? [],
    allGroups = allGroupsQuery.data ?? [],
    allCollections = allCollectionsQuery.data ?? [],
    datasets = datasetsQuery.data ?? [],
    memberships = membershipsQuery.data ?? [];

  if (collectionQuery.isPending) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  // `null` is the RLS-hidden/gone read; `undefined` (an errored query) gets
  // the same card — the boundary fallback the dataset page uses.
  if (collection === null || collection === undefined) {
    return <PgCollectionNotFoundCard />;
  }

  const groupIds = new Set(groups.map((group) => group.id)),
    groupMembers = (groupId: string): DatasetSummaryRow[] =>
      datasets.filter((dataset) => dataset.groupId === groupId),
    // Datasets joined DIRECTLY to this collection that don't sit in one of
    // its groups (group members render under their group).
    ungrouped = datasets.filter(
      (dataset) =>
        memberships.some(
          (membership) =>
            membership.collectionId === collectionId && membership.datasetId === dataset.id,
        ) &&
        (dataset.groupId === null || !groupIds.has(dataset.groupId)),
    ),
    memberDatasetIds = new Set(
      memberships
        .filter((membership) => membership.collectionId === collectionId)
        .map((membership) => membership.datasetId),
    ),
    // Whether the collection holds ANY datasets — direct joins or group
    // members (a group brings its datasets, so a collection whose datasets
    // all live in its groups still has content).
    collectionIsEmpty =
      ungrouped.length === 0 && groups.every((group) => groupMembers(group.id).length === 0),
    invalidateCatalog = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    },
    handleMoveToGroup = async (dataset: DatasetSummaryRow, groupId: string | null) => {
      try {
        await groupsStore.setDatasetGroup({ groupId, datasetId: dataset.id });
        invalidateCatalog();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to move dataset."));
      }
    },
    handleRemoveFromCollection = async (dataset: DatasetSummaryRow) => {
      try {
        await collectionsStore.removeFromCollection({ collectionId, datasetId: dataset.id });
        invalidateCatalog();
        toast.success(`Removed "${dataset.title}" from the collection.`);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to remove dataset."));
      }
    },
    handleDeleteCollection = async () => {
      try {
        await collectionsStore.remove({ collectionId });
        invalidateCatalog();
        toast.success("Collection deleted.");
        await navigate({ to: "/collections" });
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete collection."));
      }
    },
    handleDeleteGroup = async () => {
      if (pendingDeleteGroup === undefined) {
        return;
      }
      try {
        await groupsStore.remove({ groupId: pendingDeleteGroup.id });
        invalidateCatalog();
        toast.success("Group deleted.");
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete group."));
      }
    };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-0">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/collections" />}>Collections</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{collection.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-primary">
            <Layers className="h-6 w-6" />
            {collection.name}
          </h1>
          {collection.description !== null && (
            <p className="mt-2 text-lg text-muted-foreground">{collection.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingCollection(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPendingDeleteCollection(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setEditingGroup(undefined);
              setGroupFormOpen(true);
            }}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            New group
          </Button>
          <Button
            onClick={() => {
              setAddDatasetTarget("collection");
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add dataset
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <PgCollectionGroupCard
            key={group.id}
            group={group}
            groups={allGroups}
            members={groupMembers(group.id)}
            onAddDataset={setAddDatasetTarget}
            onDelete={setPendingDeleteGroup}
            onEdit={(target) => {
              setEditingGroup(target);
              setGroupFormOpen(true);
            }}
            onMoveToGroup={(dataset, groupId) => {
              void handleMoveToGroup(dataset, groupId);
            }}
            onRemoveDataset={(dataset) => {
              void handleRemoveFromCollection(dataset);
            }}
          />
        ))}

        <Card>
          <CardHeader>
            <CardTitle>{groups.length > 0 ? "Datasets outside its groups" : "Datasets"}</CardTitle>
            <CardDescription>
              Datasets in this collection that aren't in one of its groups
            </CardDescription>
          </CardHeader>
          <CardContent>
            {collectionIsEmpty ? (
              <Empty className="min-h-32 border">
                <EmptyTitle>No datasets yet</EmptyTitle>
                <EmptyDescription>
                  Add a dataset to this collection to get started.
                </EmptyDescription>
              </Empty>
            ) : (
              <PgMemberList
                collectionId={collectionId}
                datasets={ungrouped}
                groups={allGroups}
                emptyLabel={
                  groups.length > 0
                    ? "Every dataset here is inside a group above."
                    : "No datasets in this collection yet."
                }
                onMoveToGroup={(dataset, groupId) => {
                  void handleMoveToGroup(dataset, groupId);
                }}
                onRemoveFromCollection={(dataset) => {
                  void handleRemoveFromCollection(dataset);
                }}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <PgCollectionFormPanel
        collection={collection}
        open={editingCollection}
        onOpenChange={setEditingCollection}
      />

      <PgGroupFormPanel
        collectionId={collectionId}
        collections={allCollections}
        group={editingGroup}
        open={groupFormOpen}
        onOpenChange={setGroupFormOpen}
      />

      <PgCollectionAddSheet
        collectionId={collectionId}
        collectionName={collection.name}
        datasets={datasets}
        groups={allGroups}
        memberDatasetIds={memberDatasetIds}
        open={addDatasetTarget === "collection"}
        resolveCollectionName={(id) => {
          const match = allCollections.find((candidate) => candidate.id === id);
          return match === undefined ? "another collection" : match.name;
        }}
        onOpenChange={(open) => {
          if (!open) {
            setAddDatasetTarget(undefined);
          }
        }}
      />

      {addDatasetTarget !== undefined && addDatasetTarget !== "collection" && (
        <PgDatasetPickerSheet
          title="Add dataset to group"
          description={`Choose a dataset to add to "${addDatasetTarget.name}".`}
          candidates={datasets.filter((dataset) => dataset.groupId !== addDatasetTarget.id)}
          open
          onOpenChange={(open) => {
            if (!open) {
              setAddDatasetTarget(undefined);
            }
          }}
          onPick={async (dataset) => {
            await groupsStore.setDatasetGroup({
              datasetId: dataset.id,
              groupId: addDatasetTarget.id,
            });
            invalidateCatalog();
            toast.success(`Added "${dataset.title}" to "${addDatasetTarget.name}".`);
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteCollection}
        onOpenChange={setPendingDeleteCollection}
        title={`Delete "${collection.name}"?`}
        description="Its groups will become standalone, and datasets lose this collection (their other collections stay). Datasets themselves stay put."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteCollection();
        }}
      />

      <ConfirmDialog
        open={pendingDeleteGroup !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteGroup(undefined);
          }
        }}
        title={pendingDeleteGroup === undefined ? "" : `Delete "${pendingDeleteGroup.name}"?`}
        description="Its datasets are not deleted — they just become ungrouped."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteGroup();
        }}
      />
    </div>
  );
}

/** The Postgres edition of `/collections/$collectionId`. */
export function PgCollectionPage({ collectionId }: { collectionId: string }) {
  return <PgCollectionPageBody collectionId={collectionId} />;
}

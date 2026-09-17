import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { FolderOpen, Layers, MapIcon, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AddToMapSheet } from "#/components/add-to-map-sheet";
import { CollectionAddSheet } from "#/components/collection-add-sheet";
import { CollectionFormPanel } from "#/components/collection-form-panel";
import { DatasetList } from "#/components/dataset-list";
import type { Dataset, GroupDoc } from "#/components/dataset-list";
import { DatasetPickerSheet } from "#/components/dataset-picker-sheet";
import { CollectionExtentMap } from "#/components/datasets-map";
import { GroupFormPanel } from "#/components/group-form-panel";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { api } from "#convex/_generated/api";

export const Route = createFileRoute("/collections/$collectionId/")({
  component: CollectionDetailPage,
});

function GroupCard({
  group,
  groups,
  datasets,
  onEdit,
  onDelete,
  onAddDataset,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  group: GroupDoc;
  groups: GroupDoc[];
  datasets: Dataset[];
  onEdit: (group: GroupDoc) => void;
  onDelete: (group: GroupDoc) => void;
  onAddDataset: (group: GroupDoc) => void;
  onMoveToGroup: (dataset: Dataset, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: Dataset) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>
            <Link to="/groups/$groupId" params={{ groupId: group._id }} className="hover:underline">
              {group.name}
            </Link>
          </CardTitle>
          {group.description && <CardDescription>{group.description}</CardDescription>}
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
        <DatasetList
          datasets={datasets}
          groups={groups}
          emptyLabel="No datasets in this group yet."
          onMoveToGroup={onMoveToGroup}
          onRemoveFromCollection={onRemoveFromCollection}
        />
      </CardContent>
    </Card>
  );
}

function UngroupedDatasetsCard({
  hasGroups,
  hasContent,
  ungrouped,
  groups,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  hasGroups: boolean;
  // Whether the collection holds ANY datasets — direct joins or group
  // members (a group brings its datasets, so a collection whose datasets all
  // live in its groups still "has content" and shouldn't read as empty).
  hasContent: boolean;
  ungrouped: Dataset[];
  groups: GroupDoc[];
  onMoveToGroup: (dataset: Dataset, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: Dataset) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasGroups ? "Datasets outside its groups" : "Datasets"}</CardTitle>
        <CardDescription>
          Datasets in this collection that aren't in one of its groups
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasContent ? (
          <DatasetList
            datasets={ungrouped}
            groups={groups}
            emptyLabel="Every dataset here is inside a group above."
            onMoveToGroup={onMoveToGroup}
            onRemoveFromCollection={onRemoveFromCollection}
          />
        ) : (
          <Empty className="min-h-32 border">
            <EmptyTitle>No datasets yet</EmptyTitle>
            <EmptyDescription>Add a dataset to this collection to get started.</EmptyDescription>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The extent map above the collection's dataset list: one dashed
 * color-coded rectangle per geospatial dataset, fit to their combined
 * extent (see `CollectionExtentMap`). This renders no individual features —
 * each group gets its own full feature-layer page, and the dataset list
 * stays this page's focus. It reads only the datasets' server-maintained
 * `boundingBox` extents, so it renders immediately with no geometry
 * queries on page open.
 */
function CollectionMapSection({ datasets }: { datasets: Dataset[] }) {
  const geospatialDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.kind === "geospatial"),
    [datasets],
  );

  if (geospatialDatasets.length === 0) {
    return null;
  }

  return (
    <section className="mb-6" aria-label="Spatial extent of the datasets in this collection">
      <div className="relative h-[320px] w-full overflow-hidden rounded-lg border border-border">
        <CollectionExtentMap datasets={geospatialDatasets} />
      </div>
    </section>
  );
}

function CollectionDetailPage() {
  const { collectionId } = Route.useParams(),
    navigate = useNavigate(),
    collection = useQuery(api.collections.get, { collectionId }),
    collections = useQuery(api.collections.list),
    groups = useQuery(api.groups.list, { collectionId }),
    allGroups = useQuery(api.groups.list, {}),
    collectionDatasets = useQuery(api.collections.listDatasets, { collectionId }),
    allDatasets = useQuery(api.schemas.list),
    memberships = useQuery(api.collections.listSchemaCollections),
    deleteCollectionMutation = useMutation(api.collections.remove),
    deleteGroupMutation = useMutation(api.groups.remove),
    setSchemaGroup = useMutation(api.collections.setSchemaGroup),
    removeSchemaFromCollection = useMutation(api.collections.removeSchemaFromCollection),
    [editingCollection, setEditingCollection] = useState(false),
    [pendingDeleteCollection, setPendingDeleteCollection] = useState(false),
    [groupFormOpen, setGroupFormOpen] = useState(false),
    [editingGroup, setEditingGroup] = useState<GroupDoc | undefined>(),
    [pendingDeleteGroup, setPendingDeleteGroup] = useState<GroupDoc | undefined>(),
    [addDatasetTarget, setAddDatasetTarget] = useState<"collection" | GroupDoc | undefined>(),
    [addToMapOpen, setAddToMapOpen] = useState(false),
    handleMoveToGroup = async (dataset: Dataset, groupId: string | null) => {
      try {
        await setSchemaGroup({ groupId, schemaId: dataset._id });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to move dataset.");
      }
    },
    handleRemoveFromCollection = async (dataset: Dataset) => {
      try {
        await removeSchemaFromCollection({ collectionId, schemaId: dataset._id });
        toast.success(`Removed "${dataset.title}" from the collection.`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to remove dataset.");
      }
    },
    handleDeleteCollection = async () => {
      try {
        await deleteCollectionMutation({ collectionId });
        toast.success("Collection deleted.");
        await navigate({ to: "/collections" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete collection.");
      }
    },
    handleDeleteGroup = async () => {
      if (!pendingDeleteGroup) {
        return;
      }
      try {
        await deleteGroupMutation({ groupId: pendingDeleteGroup._id });
        toast.success("Group deleted.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete group.");
      }
    };

  if (
    collection === undefined ||
    collections === undefined ||
    groups === undefined ||
    allGroups === undefined ||
    collectionDatasets === undefined ||
    allDatasets === undefined ||
    memberships === undefined
  ) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!collection) {
    return (
      <Card className="mx-auto mt-8 max-w-md text-center py-12">
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

  const groupIds = new Set(groups.map((group) => group._id)),
    // Datasets joined to this collection that don't sit in one of its groups.
    ungrouped = collectionDatasets.filter(
      (dataset) => dataset.groupId === undefined || !groupIds.has(dataset.groupId),
    ),
    // Everything the collection contains: datasets joined directly, plus
    // every dataset of a group living in the collection — a group joins as a
    // single unit (see CollectionAddSheet) and brings its members along. The
    // extent map and map layers derive from this, so a collection map really
    // is the whole collection.
    collectionContentDatasets = allDatasets.filter(
      (dataset) =>
        memberships.some(
          (membership) =>
            membership.collectionId === collectionId && membership.schemaId === dataset._id,
        ) ||
        (dataset.groupId !== undefined && groupIds.has(dataset.groupId)),
    );

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
      <div className="flex justify-between items-start mb-8">
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
          <h1 className="text-3xl font-bold text-primary flex items-center gap-2">
            <Layers className="h-6 w-6" />
            {collection.name}
          </h1>
          {collection.description && (
            <p className="text-lg text-muted-foreground mt-2">{collection.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingCollection(true);
            }}
          >
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPendingDeleteCollection(true);
            }}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setEditingGroup(undefined);
              setGroupFormOpen(true);
            }}
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            New group
          </Button>
          <Button
            onClick={() => {
              setAddDatasetTarget("collection");
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add dataset
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setAddToMapOpen(true);
            }}
          >
            <MapIcon className="h-4 w-4 mr-2" />
            Add to map
          </Button>
        </div>
      </div>

      <CollectionMapSection datasets={collectionContentDatasets} />

      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <GroupCard
            key={group._id}
            group={group}
            groups={allGroups}
            datasets={allDatasets.filter((dataset) => dataset.groupId === group._id)}
            onEdit={(target) => {
              setEditingGroup(target);
              setGroupFormOpen(true);
            }}
            onDelete={setPendingDeleteGroup}
            onAddDataset={setAddDatasetTarget}
            onMoveToGroup={(dataset, groupId) => {
              void handleMoveToGroup(dataset, groupId);
            }}
            onRemoveFromCollection={(dataset) => {
              void handleRemoveFromCollection(dataset);
            }}
          />
        ))}

        <UngroupedDatasetsCard
          hasGroups={groups.length > 0}
          hasContent={collectionContentDatasets.length > 0}
          ungrouped={ungrouped}
          groups={allGroups}
          onMoveToGroup={(dataset, groupId) => {
            void handleMoveToGroup(dataset, groupId);
          }}
          onRemoveFromCollection={(dataset) => {
            void handleRemoveFromCollection(dataset);
          }}
        />
      </div>

      <CollectionFormPanel
        collection={collection}
        open={editingCollection}
        onOpenChange={setEditingCollection}
      />

      <GroupFormPanel
        collectionId={collectionId}
        group={editingGroup}
        open={groupFormOpen}
        onOpenChange={setGroupFormOpen}
      />

      <CollectionAddSheet
        collectionId={collectionId}
        collectionName={collection.name}
        collections={collections}
        groups={allGroups}
        datasets={allDatasets}
        memberships={memberships}
        open={addDatasetTarget === "collection"}
        onOpenChange={(open) => {
          if (!open) {
            setAddDatasetTarget(undefined);
          }
        }}
      />

      {addDatasetTarget !== undefined && addDatasetTarget !== "collection" && (
        <DatasetPickerSheet
          title="Add dataset to group"
          description={`Choose a dataset to add to "${addDatasetTarget.name}".`}
          candidates={allDatasets.filter((dataset) => dataset.groupId !== addDatasetTarget._id)}
          open
          onOpenChange={(open) => {
            if (!open) {
              setAddDatasetTarget(undefined);
            }
          }}
          onPick={async (dataset) => {
            await setSchemaGroup({ groupId: addDatasetTarget._id, schemaId: dataset._id });
            toast.success(`Added "${dataset.title}" to "${addDatasetTarget.name}".`);
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteCollection}
        onOpenChange={setPendingDeleteCollection}
        title={`Delete "${collection.name}"?`}
        description="Its groups will be deleted too. Datasets inside stay put — they just lose this collection (and their other collections stay)."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteCollection();
        }}
      />

      <AddToMapSheet
        open={addToMapOpen}
        onOpenChange={setAddToMapOpen}
        target={{ targetId: collectionId, targetType: "collection", targetName: collection.name }}
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

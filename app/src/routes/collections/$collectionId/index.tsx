import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  FolderOpen,
  Layers,
  Map as MapIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Ungroup,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CollectionFormPanel } from "#/components/collection-form-panel";
import { DatasetPickerSheet } from "#/components/dataset-picker-sheet";
import { DatasetsMap } from "#/components/datasets-map";
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Select } from "#/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { api } from "#convex/_generated/api";

type GroupDoc = FunctionReturnType<typeof api.groups.list>[number];
type Dataset = FunctionReturnType<typeof api.schemas.list>[number];

export const Route = createFileRoute("/collections/$collectionId/")({
  component: CollectionDetailPage,
});

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

function DatasetList({
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
          <CardTitle>{group.name}</CardTitle>
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
  collectionDatasets,
  ungrouped,
  groups,
  onMoveToGroup,
  onRemoveFromCollection,
}: {
  hasGroups: boolean;
  collectionDatasets: Dataset[];
  ungrouped: Dataset[];
  groups: GroupDoc[];
  onMoveToGroup: (dataset: Dataset, groupId: string | null) => void;
  onRemoveFromCollection: (dataset: Dataset) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasGroups ? "Ungrouped datasets" : "Datasets"}</CardTitle>
        <CardDescription>Datasets directly in this collection</CardDescription>
      </CardHeader>
      <CardContent>
        {collectionDatasets.length === 0 ? (
          <Empty className="min-h-32 border">
            <EmptyTitle>No datasets yet</EmptyTitle>
            <EmptyDescription>Add a dataset to this collection to get started.</EmptyDescription>
          </Empty>
        ) : (
          <DatasetList
            datasets={ungrouped}
            groups={groups}
            emptyLabel="Every dataset here is inside a group above."
            onMoveToGroup={onMoveToGroup}
            onRemoveFromCollection={onRemoveFromCollection}
          />
        )}
      </CardContent>
    </Card>
  );
}

const MAP_FILTER_ALL = "all",
  MAP_FILTER_UNGROUPED = "ungrouped";

/** Extracted so the group/ungrouped branches don't nest into the caller's ternary complexity. */
function filterDatasetsByGroup(datasets: Dataset[], groupFilter: string): Dataset[] {
  if (groupFilter === MAP_FILTER_ALL) {
    return datasets;
  }
  if (groupFilter === MAP_FILTER_UNGROUPED) {
    return datasets.filter((dataset) => dataset.groupId === undefined);
  }
  return datasets.filter((dataset) => dataset.groupId === groupFilter);
}

/** Combined map of every geospatial dataset in the collection, with an optional group filter. */
function CollectionMapTab({
  collectionId,
  datasets,
  groups,
}: {
  collectionId: string;
  datasets: Dataset[];
  groups: GroupDoc[];
}) {
  const geometries = useQuery(api.collections.listGeometriesByCollection, { collectionId }),
    entries = useQuery(api.collections.listEntriesByCollection, { collectionId }),
    [groupFilter, setGroupFilter] = useState(MAP_FILTER_ALL);

  if (geometries === undefined || entries === undefined) {
    return (
      <div className="flex justify-center items-center min-h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const filteredDatasets = filterDatasetsByGroup(datasets, groupFilter),
    filteredSchemaIds = new Set(filteredDatasets.map((dataset) => dataset._id)),
    filteredGeometries = geometries.filter((geometry) => filteredSchemaIds.has(geometry.schemaId)),
    filteredEntries = entries.filter((entry) => filteredSchemaIds.has(entry.schemaId));

  return (
    <div className="flex flex-col gap-4">
      {groups.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Show</span>
          <Select
            className="w-auto"
            value={groupFilter}
            onChange={(e) => {
              setGroupFilter(e.target.value);
            }}
          >
            <option value={MAP_FILTER_ALL}>All datasets</option>
            {groups.map((group) => (
              <option key={group._id} value={group._id}>
                {group.name}
              </option>
            ))}
            <option value={MAP_FILTER_UNGROUPED}>Ungrouped</option>
          </Select>
        </div>
      )}
      <DatasetsMap
        datasets={filteredDatasets}
        geometries={filteredGeometries}
        entries={filteredEntries}
      />
    </div>
  );
}

type AddDatasetTarget = "collection" | GroupDoc | undefined;

/** Hosts the "add dataset" side panel — extracted so its title/candidates ternaries don't count against the page's own complexity. */
function AddDatasetSheetHost({
  target,
  collectionId,
  collectionDatasets,
  collectionAddCandidates,
  onOpenChange,
  setSchemaCollection,
  setSchemaGroup,
}: {
  target: AddDatasetTarget;
  collectionId: string;
  collectionDatasets: Dataset[];
  collectionAddCandidates: Dataset[];
  onOpenChange: (open: boolean) => void;
  setSchemaCollection: (args: {
    collectionId: string | null;
    schemaId: string;
  }) => Promise<unknown>;
  setSchemaGroup: (args: { groupId: string | null; schemaId: string }) => Promise<unknown>;
}) {
  const isCollectionTarget = target === "collection",
    group = isCollectionTarget || target === undefined ? undefined : target,
    title = isCollectionTarget ? "Add dataset to collection" : "Add dataset to group",
    description = isCollectionTarget
      ? "Choose a dataset to add directly to this collection."
      : "Choose a dataset from this collection to add to the group.",
    candidates = isCollectionTarget
      ? collectionAddCandidates
      : collectionDatasets.filter((dataset) => dataset.groupId !== (group ? group._id : undefined));

  return (
    <DatasetPickerSheet
      title={title}
      description={description}
      candidates={candidates}
      open={target !== undefined}
      onOpenChange={onOpenChange}
      onPick={async (dataset) => {
        if (isCollectionTarget) {
          await setSchemaCollection({ collectionId, schemaId: dataset._id });
          toast.success(`Added "${dataset.title}" to the collection.`);
        } else if (group) {
          await setSchemaGroup({ groupId: group._id, schemaId: dataset._id });
          toast.success(`Added "${dataset.title}" to "${group.name}".`);
        }
      }}
    />
  );
}

function CollectionDetailPage() {
  const { collectionId } = Route.useParams(),
    navigate = useNavigate(),
    collection = useQuery(api.collections.get, { collectionId }),
    groups = useQuery(api.groups.list, { collectionId }),
    collectionDatasets = useQuery(api.collections.listDatasets, { collectionId }),
    allDatasets = useQuery(api.schemas.list),
    deleteCollectionMutation = useMutation(api.collections.remove),
    deleteGroupMutation = useMutation(api.groups.remove),
    setSchemaCollection = useMutation(api.collections.setSchemaCollection),
    setSchemaGroup = useMutation(api.collections.setSchemaGroup),
    [editingCollection, setEditingCollection] = useState(false),
    [pendingDeleteCollection, setPendingDeleteCollection] = useState(false),
    [groupFormOpen, setGroupFormOpen] = useState(false),
    [editingGroup, setEditingGroup] = useState<GroupDoc | undefined>(),
    [pendingDeleteGroup, setPendingDeleteGroup] = useState<GroupDoc | undefined>(),
    [addDatasetTarget, setAddDatasetTarget] = useState<"collection" | GroupDoc | undefined>(),
    handleMoveToGroup = async (dataset: Dataset, groupId: string | null) => {
      try {
        await setSchemaGroup({ groupId, schemaId: dataset._id });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to move dataset.");
      }
    },
    handleRemoveFromCollection = async (dataset: Dataset) => {
      try {
        await setSchemaCollection({ collectionId: null, schemaId: dataset._id });
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

  if (collection === undefined || groups === undefined || collectionDatasets === undefined) {
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

  const ungrouped = collectionDatasets.filter((dataset) => dataset.groupId === undefined),
    collectionAddCandidates = (allDatasets ?? []).filter(
      (dataset) => dataset.collectionId !== collectionId,
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
        </div>
      </div>

      <Tabs defaultValue="datasets">
        <TabsList>
          <TabsTrigger value="datasets">Datasets</TabsTrigger>
          {collectionDatasets.some((dataset) => dataset.kind === "geospatial") && (
            <TabsTrigger value="map">
              <MapIcon className="h-3.5 w-3.5" />
              Map
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="datasets">
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <GroupCard
                key={group._id}
                group={group}
                groups={groups}
                datasets={collectionDatasets.filter((dataset) => dataset.groupId === group._id)}
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
              collectionDatasets={collectionDatasets}
              ungrouped={ungrouped}
              groups={groups}
              onMoveToGroup={(dataset, groupId) => {
                void handleMoveToGroup(dataset, groupId);
              }}
              onRemoveFromCollection={(dataset) => {
                void handleRemoveFromCollection(dataset);
              }}
            />
          </div>
        </TabsContent>

        <TabsContent value="map">
          <CollectionMapTab collectionId={collectionId} datasets={collectionDatasets} groups={groups} />
        </TabsContent>
      </Tabs>

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

      <AddDatasetSheetHost
        target={addDatasetTarget}
        collectionId={collectionId}
        collectionDatasets={collectionDatasets}
        collectionAddCandidates={collectionAddCandidates}
        onOpenChange={(open) => {
          if (!open) {
            setAddDatasetTarget(undefined);
          }
        }}
        setSchemaCollection={setSchemaCollection}
        setSchemaGroup={setSchemaGroup}
      />

      <ConfirmDialog
        open={pendingDeleteCollection}
        onOpenChange={setPendingDeleteCollection}
        title={`Delete "${collection.name}"?`}
        description="Its groups will be deleted too. Datasets inside stay put — they just become uncategorized."
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
        description="Its datasets stay in the collection — they just become ungrouped."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteGroup();
        }}
      />
    </div>
  );
}

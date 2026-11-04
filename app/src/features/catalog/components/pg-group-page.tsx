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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import * as datasetsStore from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";

import { PgDatasetPickerSheet } from "./pg-dataset-picker-sheet";
import { PgGroupFormPanel } from "./pg-group-form-panel";
import { PgMemberList } from "./pg-member-list";

/**
 * The Postgres edition of `/groups/$groupId` (the route branches on the id's
 * origin): the group's member datasets — tags + trigger-maintained counts on
 * every row, per the browser's info parity — with the group's own management
 * (edit, delete, add datasets directly). Works whether the group floats
 * standalone or lives in a collection; the breadcrumb names the parent
 * collection when there is one.
 *
 * Absent on the PG page rather than broken: the combined member map and the
 * export flows (the maps/export workstreams' PG catalog-target slices).
 */

function PgGroupNotFoundCard() {
  return (
    <Card className="mx-auto mt-8 max-w-md py-12 text-center">
      <CardContent className="pt-6">
        <CardTitle className="mb-2">Group Not Found</CardTitle>
        <CardDescription className="mb-4">
          The group you're looking for doesn't exist or has been deleted.
        </CardDescription>
        <Link to="/datasets">
          <Button>Back to Datasets</Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/** The group page's content, once the group read has landed. */
// oxlint-disable-next-line eslint/complexity -- the page reads both stores' catalog rows and composes the store seams; ad hoc splitting risks these render paths (the same #82 phase-2 note the sibling Convex pages carry).
function PgGroupPageBody({ groupId }: { groupId: string }) {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    groupQuery = useQuery(groupsStore.getQueryOptions({ groupId })),
    allGroupsQuery = useQuery(groupsStore.listQueryOptions()),
    datasetsQuery = useQuery(datasetsStore.listSummariesQueryOptions()),
    group = groupQuery.data,
    allGroups = allGroupsQuery.data ?? [],
    datasets = datasetsQuery.data ?? [],
    // The parent collection's name, for the breadcrumb — a dangling
    // collectionId (collection deleted; the FK is ON DELETE SET NULL, so this
    // is transient at worst) renders the segment without a name rather than a
    // dead link.
    parentCollectionId = group === undefined || group === null ? null : group.collectionId,
    parentCollectionQuery = useQuery({
      ...collectionsStore.getQueryOptions({ collectionId: parentCollectionId ?? "" }),
      enabled: parentCollectionId !== null,
    }),
    [editingGroup, setEditingGroup] = useState(false),
    [addDatasetOpen, setAddDatasetOpen] = useState(false),
    [pendingDelete, setPendingDelete] = useState(false);

  if (groupQuery.isPending) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (group === undefined || group === null) {
    return <PgGroupNotFoundCard />;
  }

  const datasetsOfGroup = datasets.filter((dataset) => dataset.groupId === groupId),
    addCandidates = datasets.filter((dataset) => dataset.groupId !== groupId),
    parentCollection = parentCollectionQuery.data,
    invalidateCatalog = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    },
    handleAddDataset = async (dataset: DatasetSummaryRow) => {
      try {
        await groupsStore.setDatasetGroup({ datasetId: dataset.id, groupId });
        invalidateCatalog();
        toast.success(`Added "${dataset.title}" to "${group.name}".`);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to add dataset."));
      }
    },
    handleMoveToGroup = async (dataset: DatasetSummaryRow, targetGroupId: string | null) => {
      try {
        await groupsStore.setDatasetGroup({ datasetId: dataset.id, groupId: targetGroupId });
        invalidateCatalog();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to move dataset."));
      }
    },
    handleDeleteGroup = async () => {
      try {
        await groupsStore.remove({ groupId });
        invalidateCatalog();
        toast.success("Group deleted.");
        await navigate({ to: "/datasets" });
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
                {group.collectionId === null ? (
                  <BreadcrumbLink render={<Link to="/datasets" />}>Datasets</BreadcrumbLink>
                ) : (
                  <BreadcrumbLink render={<Link to="/collections" />}>Collections</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {group.collectionId !== null && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={
                        <Link
                          to="/collections/$collectionId"
                          params={{ collectionId: group.collectionId }}
                        />
                      }
                    >
                      {parentCollection === undefined || parentCollection === null
                        ? "Collection"
                        : parentCollection.name}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </>
              )}
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{group.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-primary">
            <Layers className="h-6 w-6" />
            {group.name}
          </h1>
          {group.description !== null && (
            <p className="mt-2 text-lg text-muted-foreground">{group.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingGroup(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPendingDelete(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setAddDatasetOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add dataset
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Datasets ({datasetsOfGroup.length})</CardTitle>
          <CardDescription>Datasets in this group</CardDescription>
        </CardHeader>
        <CardContent>
          <PgMemberList
            datasets={datasetsOfGroup}
            groups={allGroups}
            emptyLabel="No datasets in this group yet."
            onMoveToGroup={(dataset, targetGroupId) => {
              void handleMoveToGroup(dataset, targetGroupId);
            }}
            onRemoveFromCollection={(dataset) => {
              void handleMoveToGroup(dataset, null);
            }}
          />
        </CardContent>
      </Card>

      <PgGroupFormPanel
        collections={[]}
        group={group}
        open={editingGroup}
        onOpenChange={setEditingGroup}
      />

      <PgDatasetPickerSheet
        title="Add dataset to group"
        description="Choose a dataset to add to this group."
        candidates={addCandidates}
        open={addDatasetOpen}
        onOpenChange={setAddDatasetOpen}
        onPick={handleAddDataset}
      />

      <ConfirmDialog
        open={pendingDelete}
        onOpenChange={setPendingDelete}
        title={`Delete "${group.name}"?`}
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

/** The Postgres edition of `/groups/$groupId`. */
export function PgGroupPage({ groupId }: { groupId: string }) {
  return <PgGroupPageBody groupId={groupId} />;
}

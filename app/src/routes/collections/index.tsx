import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FolderOpen, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CollectionFormPanel } from "#/components/collection-form-panel";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { api } from "#convex/_generated/api";

type Collection = FunctionReturnType<typeof api.collections.list>[number];

function CollectionCard({
  collection,
  datasetCount,
  onEdit,
  onDelete,
}: {
  collection: Collection;
  datasetCount: number;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4">
      <Link
        to="/collections/$collectionId"
        params={{ collectionId: collection._id }}
        className="flex min-w-0 flex-1 flex-col gap-1"
      >
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">{collection.name}</h3>
        </div>
        {collection.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{collection.description}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {datasetCount} {datasetCount === 1 ? "dataset" : "datasets"}
        </p>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="Collection actions" />}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              onEdit(collection);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              onDelete(collection);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
  );
}

/**
 * How many datasets a collection holds: direct joins plus every dataset of a
 * group living in the collection — a group joins as a single unit and brings
 * its members, so the card count reads the same as the collection page.
 */
function countByCollection(
  memberships: FunctionReturnType<typeof api.collections.listSchemaCollections>,
  datasets: FunctionReturnType<typeof api.schemas.list>,
  groups: FunctionReturnType<typeof api.groups.list>,
  collectionId: string,
): number {
  const memberGroupIds = new Set(
    groups.filter((group) => group.collectionId === collectionId).map((group) => group._id),
  );
  return new Set([
    ...memberships
      .filter((membership) => membership.collectionId === collectionId)
      .map((membership) => membership.schemaId),
    ...datasets
      .filter((dataset) => dataset.groupId !== undefined && memberGroupIds.has(dataset.groupId))
      .map((dataset) => dataset._id),
  ]).size;
}

function CollectionsPage() {
  const collections = useQuery(api.collections.list),
    memberships = useQuery(api.collections.listSchemaCollections),
    datasets = useQuery(api.schemas.list),
    groups = useQuery(api.groups.list, {}),
    deleteCollection = useMutation(api.collections.remove),
    [formOpen, setFormOpen] = useState(false),
    [editing, setEditing] = useState<Collection | undefined>(),
    [pendingDelete, setPendingDelete] = useState<Collection | undefined>(),
    handleDelete = async () => {
      if (!pendingDelete) {
        return;
      }
      try {
        await deleteCollection({ collectionId: pendingDelete._id });
        toast.success("Collection deleted.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete collection.");
      }
    };

  if (
    collections === undefined ||
    memberships === undefined ||
    datasets === undefined ||
    groups === undefined
  ) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-primary mb-1">Collections</h1>
          <p className="text-muted-foreground">Group related datasets together</p>
        </div>
        <Button
          onClick={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create collection
        </Button>
      </div>

      {collections.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>No collections yet</EmptyTitle>
            <EmptyDescription>
              Create a collection to organize related datasets together.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create your first collection
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {collections.map((collection) => (
            <CollectionCard
              key={collection._id}
              collection={collection}
              datasetCount={countByCollection(memberships, datasets, groups, collection._id)}
              onEdit={(target) => {
                setEditing(target);
                setFormOpen(true);
              }}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      <CollectionFormPanel collection={editing} open={formOpen} onOpenChange={setFormOpen} />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        title={pendingDelete === undefined ? "" : `Delete "${pendingDelete.name}"?`}
        description="Its groups will be deleted too. Datasets inside stay put — they just become uncategorized."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </main>
  );
}

export const Route = createFileRoute("/collections/")({
  component: CollectionsPage,
});

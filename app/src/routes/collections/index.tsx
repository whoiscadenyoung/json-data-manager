import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery as useConvexQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FolderOpen, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  CollectionFormPanel,
  PgCollectionFormPanel,
  SourceStoreBadge,
  collectionDatasetCount,
} from "#/features/catalog";
import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import type { CollectionRow } from "#/lib/store/collections";
import * as datasetsStore from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";
import { api } from "#convex/_generated/api";

export const Route = createFileRoute("/collections/")({
  component: CollectionsPage,
});

type Collection = FunctionReturnType<typeof api.cms.collections.list>[number];

/** One row of the merged list — the store is what differs; everything else renders identically. */
interface CollectionListItem {
  collection: { description: string | null | undefined; id: string; name: string };
  count: number;
  createdTime: number;
  store: "convex" | "postgres";
}

/** Which panel the open form sheet edits: a new/PG collection, or a legacy Convex one. */
type FormTarget =
  | { collection?: CollectionRow; store: "postgres" }
  | { collection: Collection; store: "convex" }
  | undefined;

function CollectionCard({
  collection,
  datasetCount,
  store,
  onEdit,
  onDelete,
}: {
  collection: { description: string | null | undefined; id: string; name: string };
  datasetCount: number;
  store: "convex" | "postgres";
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4">
      <Link
        to="/collections/$collectionId"
        params={{ collectionId: collection.id }}
        className="flex min-w-0 flex-1 flex-col gap-1"
      >
        <div className="flex flex-wrap items-center gap-2">
          <SourceStoreBadge store={store} />
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">{collection.name}</h3>
        </div>
        {collection.description !== null && (
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
              onEdit();
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              onDelete();
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
 * How many datasets a CONVEX collection holds: direct joins plus every
 * dataset of a group living in the collection — a group joins as a single
 * unit and brings its members, so the card count reads the same as the
 * collection page. (The PG side's identical rule lives in
 * `collectionDatasetCount`, shared with the PG collection page.)
 */
function countByCollection(
  memberships: FunctionReturnType<typeof api.cms.collections.listSchemaCollections>,
  datasets: FunctionReturnType<typeof api.cms.schemas.listSummaries>,
  groups: FunctionReturnType<typeof api.cms.groups.list>,
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

// oxlint-disable-next-line eslint/complexity -- the split-brain merge reads both stores; ad hoc splitting risks these render paths.
function CollectionsPage() {
  const queryClient = useQueryClient(),
    collections = useConvexQuery(api.cms.collections.list),
    memberships = useConvexQuery(api.cms.collections.listSchemaCollections, { limit: 1000 }),
    datasets = useConvexQuery(api.cms.schemas.listSummaries, { limit: 1000 }),
    groups = useConvexQuery(api.cms.groups.list, { limit: 500 }),
    pgCollections = useQuery(collectionsStore.listQueryOptions()),
    pgMemberships = useQuery(collectionsStore.listMembershipsQueryOptions()),
    pgDatasets = useQuery(datasetsStore.listSummariesQueryOptions()),
    pgGroups = useQuery(groupsStore.listQueryOptions()),
    deleteConvexCollection = useMutation(api.cms.collections.remove),
    [formTarget, setFormTarget] = useState<FormTarget>(undefined),
    [pendingDelete, setPendingDelete] = useState<CollectionListItem | undefined>(),
    handleDelete = async () => {
      if (pendingDelete === undefined) {
        return;
      }
      try {
        if (pendingDelete.store === "postgres") {
          await collectionsStore.remove({ collectionId: pendingDelete.collection.id });
          void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
          void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
        } else {
          await deleteConvexCollection({ collectionId: pendingDelete.collection.id });
        }
        toast.success("Collection deleted.");
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete collection."));
      }
    };

  // The merged, newest-first list (§14.6: both stores, badged). Convex
  // rows' `_creationTime` and PG rows' ISO `createdAt` reduce to the same
  // millisecond key.
  const items: CollectionListItem[] = [];
  if (
    collections !== undefined &&
    memberships !== undefined &&
    datasets !== undefined &&
    groups !== undefined
  ) {
    for (const collection of collections) {
      items.push({
        collection: {
          description: collection.description,
          id: collection._id,
          name: collection.name,
        },
        count: countByCollection(memberships, datasets, groups, collection._id),
        createdTime: collection._creationTime,
        store: "convex",
      });
    }
  }
  if (
    pgCollections.data !== undefined &&
    pgMemberships.data !== undefined &&
    pgDatasets.data !== undefined &&
    pgGroups.data !== undefined
  ) {
    for (const collection of pgCollections.data) {
      items.push({
        collection: {
          description: collection.description,
          id: collection.id,
          name: collection.name,
        },
        count: collectionDatasetCount(
          pgMemberships.data,
          pgDatasets.data,
          pgGroups.data,
          collection.id,
        ),
        createdTime: Date.parse(collection.createdAt),
        store: "postgres",
      });
    }
  }
  items.sort((a, b) => b.createdTime - a.createdTime);

  if (
    collections === undefined ||
    memberships === undefined ||
    datasets === undefined ||
    groups === undefined ||
    pgCollections.isPending ||
    pgMemberships.isPending ||
    pgDatasets.isPending ||
    pgGroups.isPending
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
            setFormTarget({ store: "postgres" });
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create collection
        </Button>
      </div>

      {items.length === 0 ? (
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
                setFormTarget({ store: "postgres" });
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create your first collection
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <CollectionCard
              key={`${item.store}-${item.collection.id}`}
              collection={item.collection}
              datasetCount={item.count}
              store={item.store}
              onEdit={() => {
                if (item.store === "postgres") {
                  const match = (pgCollections.data ?? []).find(
                    (candidate) => candidate.id === item.collection.id,
                  );
                  if (match !== undefined) {
                    setFormTarget({ collection: match, store: "postgres" });
                  }
                } else {
                  const match = (collections ?? []).find(
                    (candidate) => candidate._id === item.collection.id,
                  );
                  if (match !== undefined) {
                    setFormTarget({ collection: match, store: "convex" });
                  }
                }
              }}
              onDelete={() => {
                setPendingDelete(item);
              }}
            />
          ))}
        </div>
      )}

      {/* New collections are Postgres-native (the §14 transitional split —
          a PG collection is the only kind that can hold PG datasets); the
          Convex panel stays solely for the pre-migration rows' edits. */}
      <PgCollectionFormPanel
        collection={
          formTarget !== undefined && formTarget.store === "postgres"
            ? formTarget.collection
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) {
            setFormTarget(undefined);
          }
        }}
        open={formTarget !== undefined && formTarget.store === "postgres"}
      />

      <CollectionFormPanel
        collection={
          formTarget !== undefined && formTarget.store === "convex"
            ? formTarget.collection
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) {
            setFormTarget(undefined);
          }
        }}
        open={formTarget !== undefined && formTarget.store === "convex"}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        title={pendingDelete === undefined ? "" : `Delete "${pendingDelete.collection.name}"?`}
        description={
          pendingDelete !== undefined && pendingDelete.store === "postgres"
            ? "Its groups will become standalone. Datasets inside stay put — they just lose this collection."
            : "Its groups will be deleted too. Datasets inside stay put — they just become uncategorized."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </main>
  );
}

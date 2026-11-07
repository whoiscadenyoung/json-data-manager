import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Badge } from "@caden/ui/components/badge";
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
import { FolderOpen, Layers, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  PgCollectionFormPanel,
  SourceStoreBadge,
  collectionDatasetCount,
} from "#/features/catalog";
import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import type { CollectionRow } from "#/lib/store/collections";
import * as datasetsStore from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";
import * as projectsStore from "#/lib/store/projects";
import * as publishingStore from "#/lib/store/publishing";

export const Route = createFileRoute("/collections/")({
  component: CollectionsPage,
});

/** One row of the list — the store is the only origin left (stage 7). */
interface CollectionListItem {
  collection: { description: string | null; id: string; name: string };
  count: number;
  createdTime: number;
}

/**
 * The bundle-minted provenance chip (issue #262, D5's second role): the
 * collection a publish press promoted names its minting project. Both reads
 * ride RLS — an invisible bundle (a foreign project's press) renders no
 * chip, which is the honest answer. Standalone collections render none:
 * they're exploratory groupings, never project building blocks.
 */
function MintedByChip({ collectionId }: { collectionId: string }) {
  const bundles = useQuery(publishingStore.listBundlesForCollectionQueryOptions({ collectionId })),
    bundle = (bundles.data ?? []).find((candidate) => candidate.status === "completed"),
    project = useQuery({
      ...projectsStore.getQueryOptions({ projectId: bundle === undefined ? "" : bundle.projectId }),
      enabled: bundle !== undefined,
    });
  if (bundle === undefined || project.data === null || project.data === undefined) {
    return null;
  }
  return (
    <Badge title={`Minted by the “${project.data.title}” publish bundle press`} variant="secondary">
      <Sparkles className="h-3 w-3" />
      <Link
        className="hover:underline"
        params={{ projectId: project.data.id }}
        to="/projects/$projectId"
      >
        {project.data.title}
      </Link>
    </Badge>
  );
}

function CollectionCard({
  collection,
  datasetCount,
  onEdit,
  onDelete,
}: {
  collection: { description: string | null; id: string; name: string };
  datasetCount: number;
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
          <SourceStoreBadge store="postgres" />
          <MintedByChip collectionId={collection.id} />
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
 * The collections browser. Stage 7 (issue #206) collapsed the §14.6
 * split-brain merge: the pre-migration Convex collections (their
 * `api.cms.collections.*` reads, the Convex edit panel, and the Convex
 * delete mutation) are archived with the provider, so the browser lists the
 * Postgres store only. Newest-first order, the dataset counts (direct joins
 * plus every dataset of a group living in the collection — a group joins as
 * a single unit and brings its members), and the create/edit/delete flows
 * carry over unchanged. #262 (D5): both roles live here — standalone
 * creation stays an exploratory grouping, and a bundle-press-minted
 * collection names its minting project on the card.
 */
// oxlint-disable-next-line eslint/complexity -- the browser's list/edit/delete render paths are the page's real shape; the same disposition as the pre-disconnect split-brain page.
function CollectionsPage() {
  const queryClient = useQueryClient(),
    pgCollections = useQuery(collectionsStore.listQueryOptions()),
    pgMemberships = useQuery(collectionsStore.listMembershipsQueryOptions()),
    pgDatasets = useQuery(datasetsStore.listSummariesQueryOptions()),
    pgGroups = useQuery(groupsStore.listQueryOptions()),
    [formCollection, setFormCollection] = useState<CollectionRow | undefined>(undefined),
    [formOpen, setFormOpen] = useState(false),
    [pendingDelete, setPendingDelete] = useState<CollectionListItem | undefined>(),
    handleDelete = async () => {
      if (pendingDelete === undefined) {
        return;
      }
      try {
        await collectionsStore.remove({ collectionId: pendingDelete.collection.id });
        void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
        void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
        toast.success("Collection deleted.");
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete collection."));
      }
    };

  // The newest-first list: PG rows' ISO `createdAt` reduces to the
  // millisecond key the merged list sorted on.
  const items: CollectionListItem[] = [];
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
      });
    }
  }
  items.sort((a, b) => b.createdTime - a.createdTime);

  if (
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
          <p className="text-muted-foreground">
            Saved groupings — created here, or minted by a project's publish press
          </p>
        </div>
        <Button
          onClick={() => {
            setFormCollection(undefined);
            setFormOpen(true);
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
                setFormCollection(undefined);
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
          {items.map((item) => (
            <CollectionCard
              key={item.collection.id}
              collection={item.collection}
              datasetCount={item.count}
              onEdit={() => {
                const match = (pgCollections.data ?? []).find(
                  (candidate) => candidate.id === item.collection.id,
                );
                if (match !== undefined) {
                  setFormCollection(match);
                  setFormOpen(true);
                }
              }}
              onDelete={() => {
                setPendingDelete(item);
              }}
            />
          ))}
        </div>
      )}

      <PgCollectionFormPanel
        collection={formCollection}
        onOpenChange={(open) => {
          if (!open) {
            setFormCollection(undefined);
          }
          setFormOpen(open);
        }}
        open={formOpen}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        title={pendingDelete === undefined ? "" : `Delete "${pendingDelete.collection.name}"?`}
        description="Its groups will become standalone. Datasets inside stay put — they just lose this collection."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </main>
  );
}

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
import { Database, MapIcon, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { MapFormPanel } from "#/features/maps";
import { errorMessage } from "#/lib/errors";
import * as mapsStore from "#/lib/store/maps";

/**
 * One saved map as the index lists it. Stage 7 (issue #206) collapsed the
 * §14.6 split-brain union: the pre-migration Convex maps (their
 * `api.cms.maps.*` reads and delete mutation) are archived with the
 * provider, so the index lists the Postgres store only. The origin badge
 * carries over (every row is Postgres now) and the MapFormPanel submits to
 * the maps store for both create and edit.
 */
type MapsIndexEntry = {
  _id: string;
  description: string | null;
  name: string;
};

/** Per-map layer counts over the all-maps layers feed. */
function countByMap(layers: ReadonlyArray<{ mapId: string }> | undefined, mapId: string): number {
  if (layers === undefined) {
    return 0;
  }
  return layers.filter((layer) => layer.mapId === mapId).length;
}

function MapCard({
  layerCount,
  map,
  onDelete,
  onEdit,
}: {
  layerCount: number;
  map: MapsIndexEntry;
  onDelete: (map: MapsIndexEntry) => void;
  onEdit: (map: MapsIndexEntry) => void;
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4">
      <Link
        to="/maps/$mapId"
        params={{ mapId: map._id }}
        className="flex min-w-0 flex-1 flex-col gap-1"
      >
        <div className="flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">{map.name}</h3>
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Database className="h-2.5 w-2.5" />
            Postgres
          </Badge>
        </div>
        {map.description !== null && map.description !== undefined && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{map.description}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {layerCount} {layerCount === 1 ? "layer" : "layers"}
        </p>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="Map actions" />}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              onEdit(map);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              onDelete(map);
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

function MapsPage() {
  const queryClient = useQueryClient(),
    pgMaps = useQuery(mapsStore.listQueryOptions()),
    pgLayers = useQuery(mapsStore.listAllLayersQueryOptions()),
    [formOpen, setFormOpen] = useState(false),
    [editing, setEditing] = useState<MapsIndexEntry | undefined>(),
    [pendingDelete, setPendingDelete] = useState<MapsIndexEntry | undefined>(),
    maps = pgMaps.data === undefined ? undefined : pgMaps.data,
    handleDelete = async () => {
      if (pendingDelete === undefined) {
        return;
      }
      try {
        await mapsStore.remove({ mapId: pendingDelete._id });
        void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
        toast.success("Map deleted.");
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete map."));
      }
    };

  if (maps === undefined || pgLayers.data === undefined) {
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
          <h1 className="text-3xl font-bold text-primary mb-1">Maps</h1>
          <p className="text-muted-foreground">
            Compose collections, groups, and datasets into custom map views
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create map
        </Button>
      </div>

      {maps.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapIcon />
            </EmptyMedia>
            <EmptyTitle>No maps yet</EmptyTitle>
            <EmptyDescription>
              Create a map to arrange collections, groups, and datasets on a single canvas.
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
              Create your first map
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {maps.map((row) => {
            const map: MapsIndexEntry = {
              _id: row.id,
              description: row.description,
              name: row.name,
            };
            return (
              <MapCard
                key={map._id}
                layerCount={countByMap(pgLayers.data, map._id)}
                map={map}
                onEdit={(target) => {
                  setEditing(target);
                  setFormOpen(true);
                }}
                onDelete={setPendingDelete}
              />
            );
          })}
        </div>
      )}

      <MapFormPanel
        map={
          editing === undefined
            ? undefined
            : {
                _id: editing._id,
                description: editing.description ?? undefined,
                name: editing.name,
              }
        }
        open={formOpen}
        onOpenChange={setFormOpen}
        onSubmit={async (args) => {
          if (editing === undefined) {
            await mapsStore.create({ description: args.description, name: args.name });
            void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
            return;
          }
          await mapsStore.update({
            description: args.description,
            mapId: editing._id,
            name: args.name,
          });
          void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        title={pendingDelete === undefined ? "" : `Delete "${pendingDelete.name}"?`}
        description="The map's layers will be removed. The collections, groups, and datasets behind them stay put."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </main>
  );
}

export const Route = createFileRoute("/maps/")({
  component: MapsPage,
});

import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MapIcon, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { MapFormPanel } from "#/components/map-form-panel";
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

type MapDoc = FunctionReturnType<typeof api.maps.list>[number];

function MapCard({
  map,
  layerCount,
  onEdit,
  onDelete,
}: {
  map: MapDoc;
  layerCount: number;
  onEdit: (map: MapDoc) => void;
  onDelete: (map: MapDoc) => void;
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
        </div>
        {map.description && (
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

function countByMap(
  layers: FunctionReturnType<typeof api.maps.listLayers> | undefined,
  mapId: string,
): number {
  if (layers === undefined) {
    return 0;
  }
  return layers.filter((layer) => layer.mapId === mapId).length;
}

function MapsPage() {
  const maps = useQuery(api.maps.list),
    layers = useQuery(api.maps.listLayers, {}),
    deleteMap = useMutation(api.maps.remove),
    [formOpen, setFormOpen] = useState(false),
    [editing, setEditing] = useState<MapDoc | undefined>(),
    [pendingDelete, setPendingDelete] = useState<MapDoc | undefined>(),
    handleDelete = async () => {
      if (!pendingDelete) {
        return;
      }
      try {
        await deleteMap({ mapId: pendingDelete._id });
        toast.success("Map deleted.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete map.");
      }
    };

  if (maps === undefined || layers === undefined) {
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
          {maps.map((map) => (
            <MapCard
              key={map._id}
              map={map}
              layerCount={countByMap(layers, map._id)}
              onEdit={(target) => {
                setEditing(target);
                setFormOpen(true);
              }}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      <MapFormPanel map={editing} open={formOpen} onOpenChange={setFormOpen} />

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

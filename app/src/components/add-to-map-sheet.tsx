import { useMutation, useQuery } from "convex/react";
import { Check, MapIcon, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import type { LayerTargetType, MapLayerDoc } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

type AddToMapTarget = { targetId: string; targetType: LayerTargetType; targetName: string };

type MapSummary = { _id: string; name: string };

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** The searchable list of existing maps, with per-map add buttons ("Added" badge when the target is already a layer). */
function ExistingMapsSection({
  maps,
  layers,
  target,
  search,
  onSearchChange,
  pendingKey,
  onAdd,
}: {
  maps: MapSummary[];
  layers: MapLayerDoc[];
  target: AddToMapTarget;
  search: string;
  onSearchChange: (value: string) => void;
  pendingKey: string | undefined;
  onAdd: (map: MapSummary) => void;
}) {
  const layerCountByMap = new globalThis.Map<string, number>();
  for (const layer of layers) {
    layerCountByMap.set(layer.mapId, (layerCountByMap.get(layer.mapId) ?? 0) + 1);
  }

  const alreadyLayered = (mapId: string) =>
      layers.some(
        (layer) =>
          layer.mapId === mapId &&
          layer.targetType === target.targetType &&
          layer.targetId === target.targetId,
      ),
    normalizedSearch = search.trim().toLowerCase(),
    visibleMaps = normalizedSearch
      ? maps.filter((map) => map.name.toLowerCase().includes(normalizedSearch))
      : maps;

  return (
    <section className="flex flex-col gap-2" aria-label="Existing maps">
      <h3 className="text-xs font-medium text-muted-foreground">Existing maps</h3>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            onSearchChange(e.target.value);
          }}
          placeholder="Search maps…"
          className="pl-7"
        />
      </div>
      {visibleMaps.length === 0 ? (
        <Empty className="min-h-32 border">
          <EmptyTitle>No matches</EmptyTitle>
          <EmptyDescription>No maps match your search.</EmptyDescription>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-1">
          {visibleMaps.map((map) => {
            const layerCount = layerCountByMap.get(map._id) ?? 0;
            return (
              <li
                key={map._id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <MapIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{map.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {layerCount} {layerCount === 1 ? "layer" : "layers"}
                    </p>
                  </div>
                </div>
                {alreadyLayered(map._id) ? (
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
                      onAdd(map);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {pendingKey === map._id ? "Adding…" : "Add"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Side panel for adding something (a dataset, collection, or group) to a map
 * as a layer: pick one of the existing maps, or type a name to create a new
 * map with this target as its first layer.
 */
export function AddToMapSheet({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AddToMapTarget;
}) {
  const maps = useQuery(api.maps.list),
    layers = useQuery(api.maps.listLayers, {}),
    createMap = useMutation(api.maps.create),
    addLayer = useMutation(api.maps.addLayer),
    [search, setSearch] = useState(""),
    [newName, setNewName] = useState(""),
    // Which add is in flight — a map id, or "__new__" for create-and-add.
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    isPending = pendingKey !== undefined,
    handleAddToExisting = async (map: MapSummary) => {
      setPendingKey(map._id);
      try {
        await addLayer({
          mapId: map._id,
          targetId: target.targetId,
          targetType: target.targetType,
        });
        toast.success(`Added "${target.targetName}" to map "${map.name}".`);
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to add to map."));
      } finally {
        setPendingKey(undefined);
      }
    },
    handleCreateAndAdd = async () => {
      const name = newName.trim();
      if (!name) {
        toast.error("Give the map a name.");
        return;
      }
      setPendingKey("__new__");
      try {
        const mapId = await createMap({ name });
        await addLayer({
          mapId,
          targetId: target.targetId,
          targetType: target.targetType,
        });
        toast.success(`Created map "${name}" with "${target.targetName}" as its first layer.`);
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to create map."));
      } finally {
        setPendingKey(undefined);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
          setNewName("");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to map</SheetTitle>
          <SheetDescription>
            Add "{target.targetName}" to a map as a layer, or start a new map with it.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <section className="flex flex-col gap-2 rounded-md border p-3" aria-label="New map">
            <Label htmlFor="add-to-map-new-name">New map</Label>
            <p className="text-xs text-muted-foreground">
              Creates a map and adds "{target.targetName}" as its first layer.
            </p>
            <div className="flex gap-2">
              <Input
                id="add-to-map-new-name"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                }}
                placeholder="Map name"
              />
              <Button
                variant="outline"
                disabled={isPending}
                onClick={() => {
                  void handleCreateAndAdd();
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {pendingKey === "__new__" ? "Creating…" : "Create & add"}
              </Button>
            </div>
          </section>

          {maps === undefined || layers === undefined ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          ) : maps.length === 0 ? (
            <Empty className="min-h-32 border">
              <EmptyTitle>No maps yet</EmptyTitle>
              <EmptyDescription>Name your first map above to get started.</EmptyDescription>
            </Empty>
          ) : (
            <ExistingMapsSection
              maps={maps}
              layers={layers}
              target={target}
              search={search}
              onSearchChange={setSearch}
              pendingKey={pendingKey}
              onAdd={(map) => {
                void handleAddToExisting(map);
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

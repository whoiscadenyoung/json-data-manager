import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQuery as useStoreQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation, useQuery } from "convex/react";
import { Check, Database, MapIcon, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as mapsStore from "#/lib/store/maps";
import { api } from "#convex/_generated/api";

import type { LayerTargetType, MapLayerDoc } from "../lib/map-layers";

/**
 * The component targets the "add to map" sheets offer. Derived layers are
 * deliberately absent (3a, #96): a derived dataset joins a map from the map
 * workspace's own layer picker, through the wrapper that validates the
 * registry row — never as a side effect of adding a dataset or group.
 */
type AddToMapTargetType = Exclude<LayerTargetType, "derived">;

type AddToMapTarget = { targetId: string; targetType: AddToMapTargetType; targetName: string };

/** One offered map — either backend's, with the origin that routes its writes (§14.6's split-brain catalog). */
type MapSummary = { _id: string; name: string; origin: "convex" | "pg" };

/** Per-origin layer feeds the badges/counts read. */
type MapLayerFeeds = {
  convexLayers: MapLayerDoc[];
  pgLayers: mapsStore.MapLayerRow[];
};

/** The searchable list of existing maps, with per-map add buttons ("Added" badge when the target is already a layer). */
function ExistingMapsSection({
  maps,
  feeds,
  target,
  search,
  onSearchChange,
  pendingKey,
  onAdd,
}: {
  maps: MapSummary[];
  feeds: MapLayerFeeds;
  target: AddToMapTarget;
  search: string;
  onSearchChange: (value: string) => void;
  pendingKey: string | undefined;
  onAdd: (map: MapSummary) => void;
}) {
  // Layer counts and the "Added" badge read BOTH stores' layer feeds — a
  // Convex target can already be a layer of a Postgres map (the §14.6
  // cross-store layer), and vice versa at stage 3.
  const layerCountByMap = new globalThis.Map<string, number>();
  for (const layer of feeds.convexLayers) {
    layerCountByMap.set(layer.mapId, (layerCountByMap.get(layer.mapId) ?? 0) + 1);
  }
  for (const layer of feeds.pgLayers) {
    layerCountByMap.set(layer.mapId, (layerCountByMap.get(layer.mapId) ?? 0) + 1);
  }

  const alreadyLayered = (mapId: string) =>
      feeds.convexLayers.some(
        (layer) =>
          layer.mapId === mapId &&
          layer.targetType === target.targetType &&
          layer.targetId === target.targetId,
      ) ||
      feeds.pgLayers.some(
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
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {map.name}
                      {map.origin === "pg" && (
                        <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                          <Database className="h-2.5 w-2.5" />
                          PG
                        </span>
                      )}
                    </p>
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
  const maps = useQuery(api.cms.maps.list, { limit: 500 }),
    layers = useQuery(api.cms.maps.listLayers, { limit: 500 }),
    // The OTHER store's maps (stage 2's split-brain catalog): a Convex
    // target can join a Postgres map as a layer, and new maps are
    // Postgres-native from stage 2.
    pgMaps = usePostgresMaps(),
    addLayer = useMutation(api.cms.maps.addLayer),
    [search, setSearch] = useState(""),
    [newName, setNewName] = useState(""),
    // Which add is in flight — a map id, or "__new__" for create-and-add.
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    isPending = pendingKey !== undefined,
    allMaps = unionWithPg(maps, pgMaps.maps),
    handleAddToExisting = async (map: MapSummary) => {
      setPendingKey(map._id);
      try {
        if (map.origin === "pg") {
          await mapsStore.addLayer({
            mapId: map._id,
            targetId: target.targetId,
            targetType: target.targetType,
          });
          pgMaps.invalidate();
        } else {
          await addLayer({
            mapId: map._id,
            targetId: target.targetId,
            targetType: target.targetType,
          });
        }
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
        const mapId = await mapsStore.create({ name });
        await mapsStore.addLayer({
          mapId,
          targetId: target.targetId,
          targetType: target.targetType,
        });
        pgMaps.invalidate();
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

          {allMaps === undefined || layers === undefined ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          ) : allMaps.length === 0 ? (
            <Empty className="min-h-32 border">
              <EmptyTitle>No maps yet</EmptyTitle>
              <EmptyDescription>Name your first map above to get started.</EmptyDescription>
            </Empty>
          ) : (
            <ExistingMapsSection
              maps={allMaps}
              feeds={{ convexLayers: layers, pgLayers: pgMaps.layers ?? [] }}
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

/** The Postgres half of the sheet's map list (the store, with its layer feed for the badges). */
function usePostgresMaps(): {
  invalidate: () => void;
  layers: mapsStore.MapLayerRow[] | undefined;
  maps: mapsStore.MapRow[] | undefined;
} {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
    },
    layers: useMapsStoreLayers(),
    maps: useMapsStoreMaps(),
  };
}

function useMapsStoreMaps(): mapsStore.MapRow[] | undefined {
  const query = useStoreQuery(mapsStore.listQueryOptions());
  return query.data;
}

function useMapsStoreLayers(): mapsStore.MapLayerRow[] | undefined {
  const query = useStoreQuery(mapsStore.listAllLayersQueryOptions());
  return query.data;
}

/** Convex maps first (their historical order), then the Postgres ones. */
function unionWithPg(
  convexMaps: ReadonlyArray<{ _id: string; name: string }> | undefined,
  pgMaps: mapsStore.MapRow[] | undefined,
): MapSummary[] | undefined {
  if (convexMaps === undefined || pgMaps === undefined) {
    return undefined;
  }
  return [
    ...convexMaps.map((row) => ({ _id: row._id, name: row.name, origin: "convex" as const })),
    ...pgMaps.map((row) => ({ _id: row.id, name: row.name, origin: "pg" as const })),
  ];
}

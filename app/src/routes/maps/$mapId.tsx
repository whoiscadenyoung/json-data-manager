import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Layers as LayersIcon, Loader2, MapIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { LayersMap } from "#/components/layers-map";
import { MapFormPanel } from "#/components/map-form-panel";
import { MapLayerPanel } from "#/components/map-layer-panel";
import { MapLayerPickerSheet } from "#/components/map-layer-picker";
import { useGeometriesBySchemas } from "#/components/schema-geometries-loader";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  assignDatasetColors,
  buildLayerChildren,
  expandLayerDatasets,
  overridesByLayerId,
  resolveVisibleSchemaIds,
} from "#/lib/map-layers";
import type { MapLayerDoc } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

export const Route = createFileRoute("/maps/$mapId")({
  component: MapDetailPage,
});

/**
 * A saved map's workspace: the combined map of its layers on the left, and
 * the layer panel on the right — add collections/groups/datasets as layers,
 * reorder them, toggle show/hide, remove them. Layers draw in list order;
 * each dataset keeps a stable color across visibility toggles.
 */
function toastError(error: unknown, fallback: string) {
  toast.error(error instanceof Error ? error.message : fallback);
}

/**
 * Reports `complete` to the parent once via callback — the same
 * child-component pattern as SchemaGeometriesLoader, whose effect-callback
 * call doesn't trip the React Compiler's setState-in-effect rule (a direct
 * setState inside this page's own effect would).
 */
function CompletionLatch({ complete, onComplete }: { complete: boolean; onComplete: () => void }) {
  useEffect(() => {
    if (complete) {
      onComplete();
    }
  }, [complete, onComplete]);
  return null;
}

/**
 * The workspace's layer mutation handlers, extracted so the page component
 * stays readable (and under the repo's complexity budget). Child toggles
 * write overrides: hiding inserts a `{visible: false}` row, showing clears
 * any override row (back to the default visible).
 */
function useMapLayerActions(mapId: string) {
  const navigate = useNavigate(),
    removeLayer = useMutation(api.maps.removeLayer),
    setLayerVisibility = useMutation(api.maps.setLayerVisibility),
    moveLayer = useMutation(api.maps.moveLayer),
    setMapLayerOverride = useMutation(api.maps.setMapLayerOverride),
    deleteMap = useMutation(api.maps.remove),
    handleRemoveLayer = async (layer: MapLayerDoc) => {
      try {
        await removeLayer({ layerId: layer._id });
      } catch (error) {
        toastError(error, "Failed to remove layer.");
      }
    },
    handleToggleVisibility = async (layer: MapLayerDoc) => {
      try {
        await setLayerVisibility({ layerId: layer._id, visible: !layer.visible });
      } catch (error) {
        toastError(error, "Failed to toggle layer.");
      }
    },
    handleToggleChild = async (layerId: string, childKey: string, currentlyVisible: boolean) => {
      try {
        await setMapLayerOverride({
          childKey,
          layerId,
          // A child's default (no override row) is visible, so HIDING writes
          // a `{visible: false}` row and SHOWING clears any row — flipping
          // this ternary makes the eye click a silent no-op.
          visible: currentlyVisible ? false : undefined,
        });
      } catch (error) {
        toastError(error, "Failed to toggle layer item.");
      }
    },
    handleMoveLayer = async (layer: MapLayerDoc, direction: "up" | "down") => {
      try {
        await moveLayer({ direction, layerId: layer._id });
      } catch (error) {
        toastError(error, "Failed to move layer.");
      }
    },
    handleDeleteMap = async () => {
      try {
        await deleteMap({ mapId });
        toast.success("Map deleted.");
        await navigate({ to: "/maps" });
      } catch (error) {
        toastError(error, "Failed to delete map.");
      }
    };
  return {
    handleDeleteMap,
    handleMoveLayer,
    handleRemoveLayer,
    handleToggleChild,
    handleToggleVisibility,
  };
}

function MapDetailPage() {
  const { mapId } = Route.useParams(),
    map = useQuery(api.maps.get, { mapId }),
    layers = useQuery(api.maps.listLayers, { mapId }),
    datasets = useQuery(api.schemas.list),
    collections = useQuery(api.collections.list),
    groups = useQuery(api.groups.list, {}),
    memberships = useQuery(api.collections.listSchemaCollections),
    addLayer = useMutation(api.maps.addLayer),
    [editingMap, setEditingMap] = useState(false),
    [addLayerOpen, setAddLayerOpen] = useState(false),
    [pendingDeleteMap, setPendingDeleteMap] = useState(false),
    {
      handleDeleteMap,
      handleMoveLayer,
      handleRemoveLayer,
      handleToggleChild,
      handleToggleVisibility,
    } = useMapLayerActions(mapId);

  // Layer → dataset expansion, dataset colors, and the unique schema id set
  // to load geometry for — ALL layers' datasets (visible or not), so showing
  // a hidden layer is an instant render filter, not a refetch. Derived
  // plainly (no useMemo): the React Compiler memoizes these automatically.
  const overrides = useQuery(api.maps.listMapLayerOverrides),
    expanded =
      layers !== undefined &&
      datasets !== undefined &&
      memberships !== undefined &&
      groups !== undefined
        ? expandLayerDatasets(layers, datasets, memberships, groups)
        : undefined,
    colorBySchema =
      layers !== undefined && expanded !== undefined
        ? assignDatasetColors(layers, expanded)
        : undefined,
    schemaIds = expanded === undefined ? [] : [...new Set([...expanded.values()].flat())],
    { geometries, servedGeometries, loaders } = useGeometriesBySchemas(schemaIds),
    // Entry data feeds the map's feature-detail popups.
    entriesQuery = useQuery(
      api.entries.listEntriesForSchemas,
      schemaIds.length > 0 ? { schemaIds } : "skip",
    ),
    entries = schemaIds.length === 0 ? [] : entriesQuery,
    // The map mounts on the first fully-complete load, then — via
    // `servedGeometries`, which keeps serving loaded schemas while a newly
    // added one streams in — stays mounted across layer adds/removes and
    // visibility toggles. Latched once, exactly like the dataset map's
    // "never re-skeleton a map the user is looking at" behavior (229150b),
    // so the loading gate never unmounts the Map instance and the camera
    // the frozen bounds protect survives.
    [hasLoadedOnce, setHasLoadedOnce] = useState(false),
    geometriesComplete = geometries !== undefined;

  if (
    map === undefined ||
    layers === undefined ||
    datasets === undefined ||
    collections === undefined ||
    groups === undefined ||
    memberships === undefined ||
    overrides === undefined ||
    expanded === undefined ||
    colorBySchema === undefined
  ) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!map) {
    return (
      <Card className="mx-auto mt-8 max-w-md text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Map Not Found</CardTitle>
          <CardDescription className="mb-4">
            The map you're looking for doesn't exist or has been deleted.
          </CardDescription>
          <Link to="/maps">
            <Button>Back to Maps</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const collectionById = new Map(collections.map((collection) => [collection._id, collection])),
    groupById = new Map(groups.map((group) => [group._id, group])),
    datasetById = new Map(datasets.map((dataset) => [dataset._id, dataset])),
    // Cascading deletes keep layers from dangling at missing targets, but
    // read the label defensively anyway — a stale label never beats a crash.
    layerName = (layer: MapLayerDoc) => {
      switch (layer.targetType) {
        case "collection": {
          const collection = collectionById.get(layer.targetId);
          return collection ? collection.name : "Deleted collection";
        }
        case "group": {
          const group = groupById.get(layer.targetId);
          return group ? group.name : "Deleted group";
        }
        default: {
          const dataset = datasetById.get(layer.targetId);
          return dataset ? dataset.title : "Deleted dataset";
        }
      }
    },
    addedTargets = new Set(layers.map((layer) => `${layer.targetType}:${layer.targetId}`)),
    overridesByLayer = overridesByLayerId(overrides),
    childrenByLayer = buildLayerChildren(layers, datasets, memberships, groups, colorBySchema),
    visibleSchemaIds = resolveVisibleSchemaIds(layers, datasets, expanded, overridesByLayer),
    datasetColorsByLayer = (layer: MapLayerDoc) =>
      (expanded.get(layer._id) ?? []).map((schemaId) => colorBySchema.get(schemaId) ?? "#3b82f6"),
    hasLayers = layers.length > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-0">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/maps" />}>Maps</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{map.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-primary">
            <MapIcon className="h-6 w-6" />
            {map.name}
          </h1>
          {map.description && (
            <p className="mt-2 text-lg text-muted-foreground">{map.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingMap(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPendingDeleteMap(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button
            onClick={() => {
              setAddLayerOpen(true);
            }}
            disabled={collections.length === 0 && groups.length === 0 && datasets.length === 0}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add layer
          </Button>
        </div>
      </div>

      {!hasLayers ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>No layers yet</EmptyTitle>
            <EmptyDescription>
              Add a collection, group, or dataset and its geometries will draw here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                setAddLayerOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add your first layer
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <CompletionLatch
            complete={geometriesComplete}
            onComplete={() => {
              setHasLoadedOnce(true);
            }}
          />
          {loaders}
          <div className="relative h-[440px] w-full overflow-hidden rounded-lg border border-border lg:h-[640px]">
            {servedGeometries === undefined || !hasLoadedOnce ? (
              // Same loading chip as the dataset map, anchored top-right so
              // the loading affordance sits in a consistent corner across
              // every map view instead of dead-center over the basemap.
              <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Loading features…
              </div>
            ) : (
              <LayersMap
                datasets={datasets}
                geometries={servedGeometries}
                entries={entries ?? []}
                visibleSchemaIds={visibleSchemaIds}
                colorBySchema={colorBySchema}
              />
            )}
          </div>
          <MapLayerPanel
            layers={layers}
            childrenByLayer={childrenByLayer}
            overridesByLayer={overridesByLayer}
            datasetColorsByLayer={datasetColorsByLayer}
            nameForLayer={layerName}
            onMove={(layer, direction) => {
              void handleMoveLayer(layer, direction);
            }}
            onToggleVisibility={(layer) => {
              void handleToggleVisibility(layer);
            }}
            onRemove={(layer) => {
              void handleRemoveLayer(layer);
            }}
            onToggleChild={(layerId, childKey, currentlyVisible) => {
              void handleToggleChild(layerId, childKey, currentlyVisible);
            }}
          />
        </div>
      )}

      <MapFormPanel map={map} open={editingMap} onOpenChange={setEditingMap} />

      <MapLayerPickerSheet
        addedTargets={addedTargets}
        collections={collections}
        groups={groups}
        datasets={datasets}
        memberships={memberships}
        open={addLayerOpen}
        onOpenChange={setAddLayerOpen}
        onPick={async (target) => {
          try {
            await addLayer({ mapId, ...target });
            toast.success("Layer added.");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to add layer.");
          }
        }}
      />

      <ConfirmDialog
        open={pendingDeleteMap}
        onOpenChange={setPendingDeleteMap}
        title={`Delete "${map.name}"?`}
        description="The map's layers will be removed. The collections, groups, and datasets behind them stay put."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteMap();
        }}
      />
    </div>
  );
}

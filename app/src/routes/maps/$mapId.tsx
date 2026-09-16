import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  FolderOpen,
  Layers as LayersIcon,
  MapIcon,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { LayersMap } from "#/components/layers-map";
import { MapFormPanel } from "#/components/map-form-panel";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { assignDatasetColors, expandLayerDatasets } from "#/lib/map-layers";
import type { MapLayerDoc } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

export const Route = createFileRoute("/maps/$mapId")({
  component: MapDetailPage,
});

const LAYER_ICONS = {
  collection: LayersIcon,
  group: FolderOpen,
  dataset: MapPin,
} as const;

const LAYER_KINDS = {
  collection: "Collection",
  group: "Group",
  dataset: "Dataset",
} as const;

/** Up to eight per-dataset color swatches (+N overflow) under a layer row — the same colors the map draws them in. */
function LayerDatasetDots({ colors }: { colors: string[] }) {
  if (colors.length === 0) {
    return null;
  }
  const shown = colors.slice(0, 8),
    overflow = colors.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((color, index) => (
        <span
          key={index}
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
        />
      ))}
      {overflow > 0 && <span className="text-xs text-muted-foreground">+{overflow}</span>}
    </span>
  );
}

function LayerRow({
  layer,
  index,
  totalCount,
  name,
  datasetColors,
  onMoveUp,
  onMoveDown,
  onToggleVisibility,
  onRemove,
}: {
  layer: MapLayerDoc;
  index: number;
  totalCount: number;
  name: string;
  datasetColors: string[];
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleVisibility: () => void;
  onRemove: () => void;
}) {
  const Icon = LAYER_ICONS[layer.targetType],
    datasetCount = datasetColors.length;
  return (
    <li
      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 transition-opacity ${
        layer.visible ? "" : "opacity-55"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {LAYER_KINDS[layer.targetType]} ·{" "}
            {datasetCount === 0
              ? "no geospatial datasets"
              : `${datasetCount} ${datasetCount === 1 ? "dataset" : "datasets"}`}
          </p>
          <LayerDatasetDots colors={datasetColors} />
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Move ${layer.visible ? "" : "hidden "}"${name}" up`}
          disabled={index === 0}
          onClick={onMoveUp}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Move ${layer.visible ? "" : "hidden "}"${name}" down`}
          disabled={index === totalCount - 1}
          onClick={onMoveDown}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={layer.visible ? `Hide "${name}"` : `Show "${name}"`}
          onClick={onToggleVisibility}
        >
          {layer.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={`Remove "${name}" from this map`}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

/**
 * A saved map's workspace: the combined map of its layers on the left, and
 * the layer panel on the right — add collections/groups/datasets as layers,
 * reorder them, toggle show/hide, remove them. Layers draw in list order;
 * each dataset keeps a stable color across visibility toggles.
 */
function MapDetailPage() {
  const { mapId } = Route.useParams(),
    navigate = useNavigate(),
    map = useQuery(api.maps.get, { mapId }),
    layers = useQuery(api.maps.listLayers, { mapId }),
    datasets = useQuery(api.schemas.list),
    collections = useQuery(api.collections.list),
    groups = useQuery(api.groups.list, {}),
    memberships = useQuery(api.collections.listSchemaCollections),
    removeLayer = useMutation(api.maps.removeLayer),
    setLayerVisibility = useMutation(api.maps.setLayerVisibility),
    moveLayer = useMutation(api.maps.moveLayer),
    addLayer = useMutation(api.maps.addLayer),
    deleteMap = useMutation(api.maps.remove),
    [editingMap, setEditingMap] = useState(false),
    [addLayerOpen, setAddLayerOpen] = useState(false),
    [pendingDeleteMap, setPendingDeleteMap] = useState(false),
    handleLayerError = (error: unknown, fallback: string) => {
      toast.error(error instanceof Error ? error.message : fallback);
    },
    handleRemoveLayer = async (layer: MapLayerDoc) => {
      try {
        await removeLayer({ layerId: layer._id });
      } catch (error) {
        handleLayerError(error, "Failed to remove layer.");
      }
    },
    handleToggleVisibility = async (layer: MapLayerDoc) => {
      try {
        await setLayerVisibility({ layerId: layer._id, visible: !layer.visible });
      } catch (error) {
        handleLayerError(error, "Failed to toggle layer.");
      }
    },
    handleMoveLayer = async (layer: MapLayerDoc, direction: "up" | "down") => {
      try {
        await moveLayer({ direction, layerId: layer._id });
      } catch (error) {
        handleLayerError(error, "Failed to move layer.");
      }
    },
    handleDeleteMap = async () => {
      try {
        await deleteMap({ mapId });
        toast.success("Map deleted.");
        await navigate({ to: "/maps" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete map.");
      }
    };

  // Layer → dataset expansion, dataset colors, and the unique schema id set
  // to load geometry for — ALL layers' datasets (visible or not), so showing
  // a hidden layer is an instant render filter, not a refetch. Derived
  // plainly (no useMemo): the React Compiler memoizes these automatically.
  const expanded =
      layers !== undefined && datasets !== undefined && memberships !== undefined
        ? expandLayerDatasets(layers, datasets, memberships)
        : undefined,
    colorBySchema =
      layers !== undefined && expanded !== undefined
        ? assignDatasetColors(layers, expanded)
        : undefined,
    schemaIds = expanded === undefined ? [] : [...new Set([...expanded.values()].flat())],
    { geometries, loaders } = useGeometriesBySchemas(schemaIds),
    // Entry data feeds the map's feature-detail popups.
    entriesQuery = useQuery(
      api.entries.listEntriesForSchemas,
      schemaIds.length > 0 ? { schemaIds } : "skip",
    ),
    entries = schemaIds.length === 0 ? [] : entriesQuery;

  if (
    map === undefined ||
    layers === undefined ||
    datasets === undefined ||
    collections === undefined ||
    groups === undefined ||
    memberships === undefined ||
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
    visibleSchemaIds = new Set(
      layers.flatMap((layer) => (layer.visible ? (expanded.get(layer._id) ?? []) : [])),
    ),
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
          {loaders}
          <div className="relative h-[440px] w-full overflow-hidden rounded-lg border border-border lg:h-[640px]">
            {geometries === undefined || entries === undefined ? (
              <div className="flex h-full items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            ) : (
              <LayersMap
                datasets={datasets}
                geometries={geometries}
                entries={entries}
                visibleSchemaIds={visibleSchemaIds}
                colorBySchema={colorBySchema}
              />
            )}
          </div>
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Layers ({layers.length})</CardTitle>
              <CardDescription>Draw order, top layer first</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2">
                {layers.map((layer, index) => (
                  <LayerRow
                    key={layer._id}
                    layer={layer}
                    index={index}
                    totalCount={layers.length}
                    name={layerName(layer)}
                    datasetColors={(expanded.get(layer._id) ?? []).map(
                      (schemaId) => colorBySchema.get(schemaId) ?? "#3b82f6",
                    )}
                    onMoveUp={() => {
                      void handleMoveLayer(layer, "up");
                    }}
                    onMoveDown={() => {
                      void handleMoveLayer(layer, "down");
                    }}
                    onToggleVisibility={() => {
                      void handleToggleVisibility(layer);
                    }}
                    onRemove={() => {
                      void handleRemoveLayer(layer);
                    }}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
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

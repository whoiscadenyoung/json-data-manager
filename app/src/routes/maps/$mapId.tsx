import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Layers as LayersIcon, Loader2, MapIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { LayersMap } from "#/components/layers-map";
import { MapFormPanel } from "#/components/map-form-panel";
import { MapLayerPanel } from "#/components/map-layer-panel";
import { MapLayerPickerSheet } from "#/components/map-layer-picker";
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
import { useGeometriesBySchemas } from "#/lib/dataset-rows-react";
import type { LayerSourceSplit } from "#/lib/layer-source";
import {
  geospatialDatasetsFor,
  splitSchemaIdsByDecision,
  useTileArchiveSources,
} from "#/lib/layer-source";
import {
  assignDatasetColors,
  buildLayerChildren,
  chainViewOf,
  expandLayerDatasets,
  overridesByLayerId,
  renderTargetsForDerivedLayers,
  resolveVisibleSchemaIds,
} from "#/lib/map-layers";
import type { DerivedDatasetSummary, MapLayerDoc } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

/** The arrived-set update for one tile source's `idle` report (bails out of the state update when already present). */
function withArrivedTileSchema(prev: Set<string>, schemaId: string): Set<string> {
  if (prev.has(schemaId)) {
    return prev;
  }
  return new Set(prev).add(schemaId);
}

/** A nullable list as an empty list — the row path serves `undefined` before its first rows land, and the map renders tile sources (or nothing) then. */
function withEmptyRows<T>(rows: T[] | undefined): T[] {
  return rows === undefined ? [] : rows;
}

/** The workspace is fully loaded: every row-path pass finished, every tile source reached `idle`, and no source decision is still pending. */
function isLayersWorkspaceComplete(
  geometries: unknown,
  split: LayerSourceSplit,
  arrivedSchemaIds: ReadonlySet<string>,
): boolean {
  if (geometries === undefined || split.sourcesPending) {
    return false;
  }
  return split.tileSources.every((source) => arrivedSchemaIds.has(source.schemaId));
}

/** The map mounts on the first served rows OR any tile source — before that only the chip shows. */
function layersMapShouldMount(geometries: unknown, split: LayerSourceSplit): boolean {
  return geometries !== undefined || split.tileSources.length > 0;
}

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

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function MapDetailPage() {
  const { mapId } = Route.useParams(),
    map = useQuery(api.maps.get, { mapId }),
    layers = useQuery(api.maps.listLayers, { limit: 500, mapId }),
    datasets = useQuery(api.schemas.listSummaries, { limit: 1000 }),
    collections = useQuery(api.collections.list),
    groups = useQuery(api.groups.list, { limit: 500 }),
    memberships = useQuery(api.collections.listSchemaCollections, { limit: 1000 }),
    // Saved derived datasets (read-time health included) — the summaries
    // projection is stage 3's single merge point. Feeds the picker's
    // candidates, the layer expansion, and the popup-title lookups.
    derivedSummaries = useQuery(api.derivedDatasets.summaries),
    // 7b (#103) chain resolutions for THIS map's dataset layers: a target
    // that holds a version chain (its project published) renders the chain —
    // head for float, the pinned row for pin. Targets without a chain
    // resolve to nothing and render themselves, exactly as before.
    resolutions = useQuery(api.bundles.layerResolutions, { mapId }),
    // Child-visibility overrides for THIS map's layers only (issue #53) —
    // the wrapper reads through the map's `by_map` layers rather than
    // collecting every map's override rows.
    overrides = useQuery(api.maps.listMapLayerOverrides, { mapId }),
    addLayer = useMutation(api.maps.addLayer),
    addDerivedLayer = useMutation(api.maps.addDerivedLayer),
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

  // Which saved derived datasets can render, and what each one's geometry
  // rides (3a, #96): ready health + a chain bottoming out at a geospatial
  // dataset. Everything downstream treats these as first-class render ids in
  // the layer pipeline (colors, visibility, expansion); only the geometry
  // subscription re-keys to the bottom source id.
  //
  // The 7b chain view rides the same datasets feed: resolved anchors get
  // ALIAS summaries (the frozen row's summary re-stamped under the draft's
  // id, archive fields stripped) so every pure helper below — expansion,
  // children, colors, visibility, extents — keeps keying the anchor id the
  // stored layer rows and override child keys use.
  const chain =
      resolutions !== undefined && datasets !== undefined
        ? chainViewOf(resolutions, datasets)
        : undefined,
    aliasedDatasets =
      datasets !== undefined && chain !== undefined ? [...datasets, ...chain.aliases] : undefined,
    renderableDerived =
      derivedSummaries !== undefined && aliasedDatasets !== undefined
        ? renderTargetsForDerivedLayers(derivedSummaries, aliasedDatasets)
        : undefined,
    // Layer → dataset expansion, dataset colors, and the unique render-id set
    // to load geometry for — ALL layers' datasets (visible or not), so showing
    // a hidden layer is an instant render filter, not a refetch. Derived
    // plainly (no useMemo): manual memoization over these live-query results
    // can't be preserved under oxlint's react/preserve-manual-memoization
    // rule, and plain consts stay lint-clean and correct — the React
    // Compiler memoizes them when it is enabled (not part of this build
    // today; these derivations are cheap).
    expanded =
      layers !== undefined &&
      aliasedDatasets !== undefined &&
      memberships !== undefined &&
      groups !== undefined &&
      renderableDerived !== undefined
        ? expandLayerDatasets(layers, aliasedDatasets, memberships, groups, renderableDerived)
        : undefined,
    colorBySchema =
      layers !== undefined && expanded !== undefined
        ? assignDatasetColors(layers, expanded)
        : undefined,
    // Retired pins (7b) render NOTHING: a pin whose version row was retired
    // resolves to nothing, and letting the layer fall back to its anchor's
    // live rows would show newer data than the pin — the stale-id leak in
    // reverse. Suppressed anchors drop out of the render id set entirely
    // (the layer panel keeps the row, marked by `layerName` below).
    suppressedAnchors = chain === undefined ? new Set<string>() : chain.suppressedAnchors,
    schemaIds =
      expanded === undefined
        ? []
        : [...new Set([...expanded.values()].flat())].filter(
            (schemaId) => !suppressedAnchors.has(schemaId),
          );
  // Layer-source decisions (issue #58 part 4): a dataset with a fresh tile
  // archive renders via `pmtiles://` range requests (no geometry-row traffic
  // for it at all); everything else stays on the row path. Derived render
  // ids never enter the decision (3a's explicit rule) — they take the row
  // path through `splitSchemaIdsByDecision`'s `derivedRowIds`, and their
  // geometry subscription re-keys to each one's bottom source dataset.
  // Derived render ids take the row path explicitly (3a's rule), and their
  // geometry subscriptions ride the BOTTOM SOURCE ids (a registry id has no
  // geometry rows — the source dataset's rows draw under the derived id).
  // `undefined` renderableDerived means the page is still loading; `schemaIds`
  // is empty then too, so the fallback branch streams nothing.
  const derivedRowIds: string[] = [],
    chainRowIds: string[] = [],
    datasetSubscriptionIds: string[] = [];
  if (renderableDerived === undefined || chain === undefined) {
    datasetSubscriptionIds.push(...schemaIds);
  } else {
    for (const schemaId of schemaIds) {
      const sourceId = renderableDerived.get(schemaId);
      if (sourceId !== undefined) {
        derivedRowIds.push(schemaId);
        datasetSubscriptionIds.push(sourceId);
        continue;
      }
      // 7b: a chain-resolved anchor subscribes its RESOLVED row's geometries
      // — the frozen data the layer renders — while the render id stays the
      // anchor (the re-key happens in LayersMap via `chainLayers`).
      const chainSource = chain.sourceByRenderId.get(schemaId);
      if (chainSource !== undefined) {
        chainRowIds.push(schemaId);
        datasetSubscriptionIds.push(chainSource);
        continue;
      }
      datasetSubscriptionIds.push(schemaId);
    }
  }
  const geometrySubscriptionIds = [...new Set(datasetSubscriptionIds)],
    sourceBySchema = useTileArchiveSources(geospatialDatasetsFor(schemaIds, aliasedDatasets)),
    split = splitSchemaIdsByDecision(schemaIds, sourceBySchema, derivedRowIds),
    tileSources = split.tileSources,
    sourcesPending = split.sourcesPending,
    { geometries, servedGeometries, loaders } = useGeometriesBySchemas(geometrySubscriptionIds),
    // Tile sources report `idle` once their viewport tiles have arrived; the
    // set of arrived sources feeds the chip's completeness below.
    [arrivedTileSchemaIds, setArrivedTileSchemaIds] = useState<Set<string>>(() => new Set()),
    // The map mounts as soon as the FIRST schema's pagination completes
    // (`servedGeometries` carries the completed schemas' rows while the rest
    // stream in) — or immediately when any layer renders from tiles — and
    // then stays mounted across layer adds/removes, visibility toggles, and
    // background re-reads, exactly like the dataset map's "never
    // re-skeleton a map the user is looking at" behavior (229150b). The
    // loading chip stays up until EVERY layer is complete: each row-path
    // layer's full pagination pass (`geometries`), each tile-path layer's
    // post-load `idle`, and no layer's source decision still pending (a
    // pending decision would otherwise flash an empty map with the chip
    // hidden — the empty row fan-out resolves immediately while the tile
    // metadata is still in flight).
    geometriesComplete = isLayersWorkspaceComplete(geometries, split, arrivedTileSchemaIds);

  if (
    map === undefined ||
    layers === undefined ||
    datasets === undefined ||
    resolutions === undefined ||
    chain === undefined ||
    aliasedDatasets === undefined ||
    collections === undefined ||
    groups === undefined ||
    memberships === undefined ||
    derivedSummaries === undefined ||
    renderableDerived === undefined ||
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
    // Alias-included: a chain-resolved anchor resolves its name/counts from
    // its frozen row (the real summaries list lacks drafts).
    datasetById = new Map(aliasedDatasets.map((dataset) => [dataset._id, dataset])),
    // Keyed by plain string: registry ids arrive branded from the validator,
    // but every layer/dataset id comparison here is string-typed.
    derivedById = new globalThis.Map<string, DerivedDatasetSummary>(
      derivedSummaries.map((summary) => [summary._id, summary]),
    ),
    // This map's datasets only — LayersMap frames its one-shot viewport from
    // these stored extents, so unrelated app datasets must not widen it.
    // Derived layers contribute nothing here on purpose: a registry row is
    // virtual (no stored extent), and a derived-only map opens on the
    // default view rather than deriving bounds from streaming rows (see
    // LayersMap's doc comment).
    mapDatasets = aliasedDatasets.filter((dataset) => schemaIds.includes(dataset._id)),
    // Cascading deletes keep layers from dangling at component targets, but
    // read the label defensively anyway — a stale label never beats a crash.
    // A "derived" target dangles whenever its registry row is deleted (the
    // component's cascade deletes cover component ids only), so its case is
    // the defensive one by construction.
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
        case "derived": {
          const derived = derivedById.get(layer.targetId);
          return derived ? derived.title : "Deleted derived dataset";
        }
        default: {
          const dataset = datasetById.get(layer.targetId);
          // A suppressed anchor is a pin whose version row was retired — the
          // stage-6 badge pattern's note, pointing at the repair path.
          const retired = suppressedAnchors.has(layer.targetId);
          const base = dataset ? dataset.title : "Deleted dataset";
          return retired ? `${base} — pinned version retired; sync to repair` : base;
        }
      }
    },
    addedTargets = new Set(layers.map((layer) => `${layer.targetType}:${layer.targetId}`)),
    overridesByLayer = overridesByLayerId(overrides),
    childrenByLayer = buildLayerChildren(
      layers,
      aliasedDatasets,
      memberships,
      groups,
      colorBySchema,
    ),
    visibleSchemaIds = resolveVisibleSchemaIds(layers, aliasedDatasets, expanded, overridesByLayer),
    datasetColorsByLayer = (layer: MapLayerDoc) =>
      (expanded.get(layer._id) ?? []).map((schemaId) => colorBySchema.get(schemaId) ?? "#3b82f6"),
    // Titles for the render ids that aren't component datasets (3a): the
    // legend and popup header resolve derived ids through the registry.
    derivedTitlesById = new globalThis.Map(
      derivedRowIds.flatMap((derivedId) => {
        const summary = derivedById.get(derivedId);
        return summary !== undefined ? [[derivedId, summary.title] as const] : [];
      }),
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
            disabled={
              collections.length === 0 &&
              groups.length === 0 &&
              datasets.length === 0 &&
              derivedSummaries.length === 0
            }
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
              Add a collection, group, dataset, or derived dataset and its geometries will draw
              here.
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
            {layersMapShouldMount(servedGeometries, split) && (
              <LayersMap
                datasets={mapDatasets}
                derivedLayers={derivedRowIds.flatMap((derivedId) => {
                  const source = renderableDerived.get(derivedId);
                  return source === undefined ? [] : [{ derivedId, sourceSchemaId: source }];
                })}
                chainLayers={chainRowIds.flatMap((renderId) => {
                  const source = chain.sourceByRenderId.get(renderId);
                  return source === undefined ? [] : [{ renderId, sourceSchemaId: source }];
                })}
                geometries={withEmptyRows(servedGeometries)}
                titlesById={derivedTitlesById}
                visibleSchemaIds={visibleSchemaIds}
                colorBySchema={colorBySchema}
                tileSources={tileSources}
                sourcesPending={sourcesPending}
                onTileSourceIdle={(schemaId) => {
                  setArrivedTileSchemaIds((prev) => withArrivedTileSchema(prev, schemaId));
                }}
              />
            )}
            {!geometriesComplete && (
              // Same loading chip as the dataset map, anchored top-right and
              // overlaid on the streaming map — it stays up until every layer
              // is complete: each row-path layer's full pagination pass, and
              // each tile-path layer's post-load `idle`.
              <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Loading features…
              </div>
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
        derivedCandidates={[...renderableDerived].flatMap(([derivedId, sourceId]) => {
          const summary = derivedById.get(derivedId),
            source = datasetById.get(sourceId);
          return summary === undefined
            ? []
            : [
                {
                  // Every renderable derived dataset is a candidate — the
                  // ones already on this map are filtered by addedTargets in
                  // the picker, so building from this map's layers alone
                  // would leave the section permanently empty.
                  detail: source === undefined ? "Derived dataset" : `Derived from ${source.title}`,
                  id: derivedId,
                  title: summary.title,
                },
              ];
        })}
        open={addLayerOpen}
        onOpenChange={setAddLayerOpen}
        onPick={async (target) => {
          try {
            // A derived target goes through the app wrapper that validates
            // the registry row before the component records the layer
            // (maps.ts addDerivedLayer — the component can't see app tables).
            if (target.targetType === "derived") {
              await addDerivedLayer({ mapId, targetId: target.targetId });
            } else {
              const { targetId, targetType } = target;
              await addLayer({ mapId, targetId, targetType });
            }
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

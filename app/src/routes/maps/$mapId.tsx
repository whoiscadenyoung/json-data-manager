import { ConfirmDialog } from "@caden/json-cms/react/ui";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@caden/ui/components/breadcrumb";
import { Button } from "@caden/ui/components/button";
import { Card, CardContent, CardDescription, CardTitle } from "@caden/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { useQueryClient } from "@tanstack/react-query";
import { useQuery as useStoreQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Layers as LayersIcon, Loader2, MapIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
// Optional styling module (docs/layer-styles.md): remove this import, the
// `useLayerStyles` call, and the `extension`/`datasetActions`/panel/loaders
// uses below to take styling out — maps then draw in their assigned colors.
import { useLayerStyles } from "#/features/layer-styles";
import {
  pgCollectionToCollectionDoc,
  pgDerivedToDerivedSummary,
  pgGroupToGroupSummary,
  pgLayerToLayerDoc,
  pgMembershipToMembershipRow,
  pgOverrideToOverride,
  pgSummaryToDatasetSummary,
  useGeometriesByPgDatasets,
} from "#/features/maps";
import {
  assignDatasetColors,
  buildLayerChildren,
  type DerivedDatasetSummary,
  expandLayerDatasets,
  LayersMap,
  type LayerSourceSplit,
  MapFormPanel,
  type MapLayerDoc,
  MapLayerPanel,
  MapLayerPickerSheet,
  overridesByLayerId,
  renderTargetsForDerivedLayers,
  resolveVisibleSchemaIds,
  splitSchemaIdsByDecision,
  useTileArchiveSources,
} from "#/features/maps";
import { isPostgresDatasetId } from "#/lib/dataset-source";
import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import { listSummariesQueryOptions, type DatasetSummaryRow } from "#/lib/store/datasets";
import * as derivedStore from "#/lib/store/derived";
import * as groupsStore from "#/lib/store/groups";
import * as mapsStore from "#/lib/store/maps";

export const Route = createFileRoute("/maps/$mapId")({
  component: MapDetailPage,
});

/**
 * The workspace route's origin split (design §14 — the id says where the
 * map was created): a Postgres map mounts the store-backed workspace
 * (`PostgresMapDetailPage` below — route-local because the styling module
 * is an optional feature wired only by routes, ADR 0011/0012). The
 * pre-migration Convex workspace is archived with the stage-7 disconnect
 * (issue #206): the Convex provider is unmounted, so a pre-migration map id
 * renders the shared archived state instead of a live `convex/react` hook.
 */
function MapDetailPage() {
  const { mapId } = Route.useParams();
  if (isPostgresDatasetId(mapId)) {
    return <PostgresMapDetailPage mapId={mapId} />;
  }
  return (
    <ArchivedConvexSurface
      description="This workspace served maps created before the Postgres migration. Pre-migration maps were retired with the old backend — Postgres maps are unaffected."
      homeTo="/maps"
      title="Convex maps are archived in this build"
    />
  );
}

function toastError(error: unknown, fallback: string) {
  toast.error(errorMessage(error, fallback));
}

// ---------------------------------------------------------------------------
// The Postgres workspace (stage 2+, issue #201): every read rides the
// `#/lib/store/*` modules and the shared layer pipeline — the rows arrive
// pre-adapted (`features/maps` exports), so one rendering path serves the
// catalog. Stage 7 (issue #206): the split-brain Convex catalog feeds (the
// convex dataset/collection/group/membership/derived summaries and the
// bundle chain resolutions that used to merge in beside these) are archived
// with the provider — this workspace reads the Postgres catalog only.
// ---------------------------------------------------------------------------

/** The arrived-set update for one tile source's `idle` report (bails out of the state update when already present). */
function withArrivedTileSchemaPg(prev: Set<string>, schemaId: string): Set<string> {
  if (prev.has(schemaId)) {
    return prev;
  }
  return new Set(prev).add(schemaId);
}

/** A nullable list as an empty list — the row path serves `undefined` before its first rows land, and the map renders tile sources (or nothing) then. */
function withEmptyRowsPg<T>(rows: T[] | undefined): T[] {
  return rows === undefined ? [] : rows;
}

/** The workspace is fully loaded: every row-path pass finished, every tile source reached `idle`, and no source decision is still pending. */
function isPgWorkspaceComplete(
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
function pgMapShouldMount(geometries: unknown, split: LayerSourceSplit): boolean {
  return geometries !== undefined || split.tileSources.length > 0;
}

const NO_PG_COLORS = new globalThis.Map<string, string>();

/** The dataset whose entries carry a render id's field values: a derived layer's bottom source, else itself (chain re-keying is archived with the Convex catalog). */
function pgEntrySourceOf(
  renderId: string,
  renderableDerived: globalThis.Map<string, string> | undefined,
): string {
  const derivedSource =
    renderableDerived === undefined ? undefined : renderableDerived.get(renderId);
  return derivedSource ?? renderId;
}

/** The PG workspace's layer mutations — the maps store, invalidated per query key. */
function usePgMapLayerActions(mapId: string, invalidate: () => void) {
  const navigate = useNavigate(),
    run = async (job: () => Promise<unknown>, fallback: string) => {
      try {
        await job();
        invalidate();
        return true;
      } catch (error) {
        toastError(error, fallback);
        return false;
      }
    };
  return {
    handleDeleteMap: async () => {
      if (await run(async () => await mapsStore.remove({ mapId }), "Failed to delete map.")) {
        toast.success("Map deleted.");
        await navigate({ to: "/maps" });
      }
    },
    handleMoveLayer: async (layer: MapLayerDoc, direction: "up" | "down") =>
      await run(
        async () => await mapsStore.moveLayer({ direction, layerId: layer._id }),
        "Failed to move layer.",
      ),
    handleRemoveLayer: async (layer: MapLayerDoc) =>
      await run(
        async () => await mapsStore.removeLayer({ layerId: layer._id }),
        "Failed to remove layer.",
      ),
    handleToggleChild: async (layerId: string, childKey: string, currentlyVisible: boolean) =>
      await run(
        async () =>
          await mapsStore.setMapLayerOverride({
            childKey,
            layerId,
            // A child's default (no override row) is visible, so HIDING
            // writes a `{visible: false}` row and SHOWING clears any row —
            // flipping this argument makes the eye click a silent no-op.
            visible: !currentlyVisible,
          }),
        "Failed to toggle layer item.",
      ),
    handleToggleVisibility: async (layer: MapLayerDoc) =>
      await run(
        async () =>
          await mapsStore.setLayerVisibility({ layerId: layer._id, visible: !layer.visible }),
        "Failed to toggle layer.",
      ),
  };
}

// oxlint-disable-next-line eslint/complexity -- the render graph is the workspace's real shape; the same disposition as the pre-disconnect split workspaces.
function PostgresMapDetailPage({ mapId }: { mapId: string }) {
  const queryClient = useQueryClient(),
    invalidateMaps = useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
    }, [queryClient]),
    map = useStoreQuery(mapsStore.getQueryOptions({ mapId })),
    layerRows = useStoreQuery(mapsStore.listLayersQueryOptions({ mapId })),
    overrideRows = useStoreQuery(mapsStore.listOverridesQueryOptions({ mapId })),
    pgSummaries = useStoreQuery(listSummariesQueryOptions()),
    pgCollections = useStoreQuery(collectionsStore.listQueryOptions()),
    pgGroups = useStoreQuery(groupsStore.listQueryOptions()),
    pgMemberships = useStoreQuery(collectionsStore.listMembershipsQueryOptions()),
    pgDerivedRows = useStoreQuery(derivedStore.summariesQueryOptions()),
    [editingMap, setEditingMap] = useState(false),
    [addLayerOpen, setAddLayerOpen] = useState(false),
    [pendingDeleteMap, setPendingDeleteMap] = useState(false),
    [pendingRemoveLayer, setPendingRemoveLayer] = useState<MapLayerDoc | undefined>(undefined),
    {
      handleDeleteMap,
      handleMoveLayer,
      handleRemoveLayer,
      handleToggleChild,
      handleToggleVisibility,
    } = usePgMapLayerActions(mapId, invalidateMaps);

  // The catalog, adapted into the shared pipeline's shapes (the adapters in
  // `features/maps`): dataset summaries, collections, groups, memberships,
  // and the derived registry — all Postgres.
  const pgAdapted =
      pgSummaries.data === undefined ? undefined : pgSummaries.data.map(pgSummaryToDatasetSummary),
    datasets = pgAdapted,
    collections =
      pgCollections.data === undefined
        ? undefined
        : pgCollections.data.map(pgCollectionToCollectionDoc),
    groups = pgGroups.data === undefined ? undefined : pgGroups.data.map(pgGroupToGroupSummary),
    memberships =
      pgMemberships.data === undefined
        ? undefined
        : pgMemberships.data.map(pgMembershipToMembershipRow),
    derivedSummaries =
      pgDerivedRows.data === undefined
        ? undefined
        : pgDerivedRows.data.map(pgDerivedToDerivedSummary),
    renderableDerived =
      derivedSummaries === undefined || datasets === undefined
        ? undefined
        : renderTargetsForDerivedLayers(derivedSummaries, datasets),
    layerDocs = layerRows.data === undefined ? undefined : layerRows.data.map(pgLayerToLayerDoc),
    expanded =
      layerDocs !== undefined &&
      datasets !== undefined &&
      memberships !== undefined &&
      groups !== undefined &&
      renderableDerived !== undefined
        ? expandLayerDatasets(layerDocs, datasets, memberships, groups, renderableDerived)
        : undefined,
    colorBySchema =
      layerDocs !== undefined && expanded !== undefined
        ? assignDatasetColors(layerDocs, expanded)
        : undefined,
    schemaIds = expanded === undefined ? [] : [...new Set([...expanded.values()].flat())];

  // Layer-source decisions over the workspace's geospatial rows (the raw
  // store summaries — the decision's PG half reads the raw archive columns).
  const pgDecisionRows: DatasetSummaryRow[] =
      pgSummaries.data === undefined
        ? []
        : pgSummaries.data.filter(
            (row) => schemaIds.includes(row.id) && row.isGeospatial && row.geometryType !== null,
          ),
    decisions = useTileArchiveSources(pgDecisionRows),
    derivedRowIds: string[] = [],
    split = splitSchemaIdsByDecision(schemaIds, decisions, derivedRowIds),
    pgRowIds = split.rowSchemaIds.filter((schemaId) => isPostgresDatasetId(schemaId)),
    pgFan = useGeometriesByPgDatasets(pgRowIds),
    geometries = pgFan.geometries,
    servedGeometries = pgFan.servedGeometries,
    [arrivedTileSchemaIds, setArrivedTileSchemaIds] = useState<Set<string>>(() => new Set()),
    geometriesComplete = isPgWorkspaceComplete(geometries, split, arrivedTileSchemaIds),
    layerStyles = useLayerStyles({
      colorBySchema: colorBySchema ?? NO_PG_COLORS,
      entrySourceFor: (renderId) => pgEntrySourceOf(renderId, renderableDerived),
      geometryTypeFor: (renderId) => {
        const sourceId = pgEntrySourceOf(renderId, renderableDerived),
          dataset =
            datasets === undefined ? undefined : datasets.find((item) => item._id === sourceId);
        return dataset === undefined ? undefined : dataset.geometryType;
      },
      mapId,
      renderIds: schemaIds,
      tileRenderIds: new Set(split.tileSources.map((source) => source.schemaId)),
    }),
    styledColorBySchema = layerStyles.colorBySchema;

  if (
    map.data === undefined ||
    layerDocs === undefined ||
    overrideRows.data === undefined ||
    datasets === undefined ||
    collections === undefined ||
    groups === undefined ||
    memberships === undefined ||
    derivedSummaries === undefined ||
    renderableDerived === undefined ||
    expanded === undefined ||
    colorBySchema === undefined
  ) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const mapData = map.data;
  if (mapData === null) {
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
    derivedById = new globalThis.Map<string, DerivedDatasetSummary>(
      derivedSummaries.map((summary) => [summary._id, summary]),
    ),
    mapDatasets = datasets.filter((dataset) => schemaIds.includes(dataset._id)),
    pgLayerName = (layer: MapLayerDoc) => {
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
          return dataset ? dataset.title : "Deleted dataset";
        }
      }
    },
    addedTargets = new Set(layerDocs.map((layer) => `${layer.targetType}:${layer.targetId}`)),
    overridesByLayer = overridesByLayerId(overrideRows.data.map(pgOverrideToOverride)),
    childrenByLayer = buildLayerChildren(
      layerDocs,
      datasets,
      memberships,
      groups,
      styledColorBySchema,
    ),
    visibleSchemaIds = resolveVisibleSchemaIds(layerDocs, datasets, expanded, overridesByLayer),
    datasetColorsByLayer = (layer: MapLayerDoc) =>
      (expanded.get(layer._id) ?? []).map(
        (schemaId) => styledColorBySchema.get(schemaId) ?? "#3b82f6",
      ),
    derivedTitlesById = new globalThis.Map(
      derivedRowIds.flatMap((derivedId) => {
        const summary = derivedById.get(derivedId);
        return summary !== undefined ? [[derivedId, summary.title] as const] : [];
      }),
    ),
    hasLayers = layerDocs.length > 0;

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
                <BreadcrumbPage>{mapData.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-primary">
            <MapIcon className="h-6 w-6" />
            {mapData.name}
          </h1>
          {mapData.description !== null && (
            <p className="mt-2 text-lg text-muted-foreground">{mapData.description}</p>
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
          {pgFan.loaders}
          <div className="relative h-[440px] w-full overflow-hidden rounded-lg border border-border lg:h-[640px]">
            {pgMapShouldMount(servedGeometries, split) && (
              <LayersMap
                datasets={mapDatasets}
                derivedLayers={derivedRowIds.flatMap((derivedId) => {
                  const source = renderableDerived.get(derivedId);
                  return source === undefined ? [] : [{ derivedId, sourceSchemaId: source }];
                })}
                chainLayers={[]}
                geometries={withEmptyRowsPg(servedGeometries)}
                titlesById={derivedTitlesById}
                visibleSchemaIds={visibleSchemaIds}
                colorBySchema={styledColorBySchema}
                tileSources={split.tileSources}
                extension={layerStyles.extension}
                sourcesPending={split.sourcesPending}
                onTileSourceIdle={(schemaId) => {
                  setArrivedTileSchemaIds((prev) => withArrivedTileSchemaPg(prev, schemaId));
                }}
              />
            )}
            {!geometriesComplete && (
              <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Loading features…
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {layerStyles.panel}
            <MapLayerPanel
              layers={layerDocs}
              childrenByLayer={childrenByLayer}
              overridesByLayer={overridesByLayer}
              datasetColorsByLayer={datasetColorsByLayer}
              nameForLayer={pgLayerName}
              onMove={(layer, direction) => {
                void handleMoveLayer(layer, direction);
              }}
              onToggleVisibility={(layer) => {
                void handleToggleVisibility(layer);
              }}
              onRemove={(layer) => {
                setPendingRemoveLayer(layer);
              }}
              onToggleChild={(layerId, childKey, currentlyVisible) => {
                void handleToggleChild(layerId, childKey, currentlyVisible);
              }}
              datasetActions={layerStyles.datasetActions}
            />
          </div>
          {layerStyles.loaders}
        </div>
      )}

      <MapFormPanel
        map={{ _id: mapData.id, name: mapData.name, description: mapData.description ?? undefined }}
        open={editingMap}
        onOpenChange={setEditingMap}
        onSubmit={async (args) => {
          await mapsStore.update({ description: args.description, mapId, name: args.name });
          invalidateMaps();
        }}
      />

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
            // Every layer of a PG map lives in PG and targets the Postgres
            // catalog (`map_layers.target_id` is plain text; the split-brain
            // Convex targets the pre-disconnect picker offered are archived,
            // issue #206).
            await mapsStore.addLayer({
              mapId,
              targetId: target.targetId,
              targetType: target.targetType,
            });
            invalidateMaps();
            toast.success("Layer added.");
          } catch (error) {
            toast.error(errorMessage(error, "Failed to add layer."));
          }
        }}
      />

      <ConfirmDialog
        open={pendingDeleteMap}
        onOpenChange={setPendingDeleteMap}
        title={`Delete "${mapData.name}"?`}
        description="The map's layers will be removed. The collections, groups, and datasets behind them stay put."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteMap();
        }}
      />

      <ConfirmDialog
        open={pendingRemoveLayer !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemoveLayer(undefined);
          }
        }}
        title={`Remove "${pendingRemoveLayer === undefined ? "" : pgLayerName(pendingRemoveLayer)}" from this map?`}
        description="The layer leaves the map. The dataset or collection behind it stays put — add it back any time."
        confirmLabel="Remove layer"
        destructive
        onConfirm={() => {
          if (pendingRemoveLayer !== undefined) {
            void handleRemoveLayer(pendingRemoveLayer);
          }
          setPendingRemoveLayer(undefined);
        }}
      />
    </div>
  );
}

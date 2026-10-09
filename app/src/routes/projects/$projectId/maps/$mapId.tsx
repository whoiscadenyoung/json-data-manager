import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { convexQuery } from "@convex-dev/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useConvexAuth, useMutation } from "convex/react";
import {
  ArrowLeft,
  Camera,
  FolderKanban,
  Layers as LayersIcon,
  Loader2,
  MapIcon,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { toast } from "sonner";

import { LayerStylePanel } from "#/components/projects/maps/layer-style-panel";
import { ProjectMapCanvas, type TileRenderLayer } from "#/components/projects/maps/layers-map";
import { MapFormPanel } from "#/components/projects/maps/map-form-panel";
import { MapLayerPanel } from "#/components/projects/maps/map-layer-panel";
import { MapLayerPickerSheet } from "#/components/projects/maps/map-layer-picker";
import { RouterButton } from "#/components/router-button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useGeometriesBySchemas } from "#/lib/dataset-rows-react";
import { errorMessage } from "#/lib/errors";
import {
  geospatialDatasetsFor,
  splitSchemaIdsByDecision,
  useTileArchiveSources,
} from "#/lib/layer-source";
import type { LayerDetail, LayerStyle, MapPlacement, RenderLayer } from "#/lib/projects/map-layers";
import {
  datasetIdByRenderId,
  datasetIdsOf,
  effectiveRenderLayers,
  isLayersWorkspaceComplete,
  keyedGeometryRows,
  layersMapShouldMount,
  renderIdsByDatasetIdOf,
  storedStyleOf,
  withArrivedTileSchema,
  withEmptyRows,
} from "#/lib/projects/map-layers";

import { api } from "../../../../../convex/_generated/api";

/**
 * The in-project map editor (phase 4 of the project-workspace design, ADR
 * 0012) — the moved-and-rebuilt workspace of the retired standalone maps,
 * now at /projects/$projectId/maps/$mapId. The canvas draws one pass per
 * RENDER layer in its STORED style (`layers.style`, edited by the style
 * panel — the client-only assignDatasetColors is gone, and two layers
 * styling one dataset draw it twice, each in its own color). The picker
 * places project layers, auto-layers datasets (inline import: membership +
 * owned layer + placement in one click), and links published layers from the
 * viewer's other projects. Every write answers to the project's
 * editors-and-up (ADR 0011); viewers read the same canvas with the reasons
 * on the disabled controls, never silent no-ops.
 */

/** The saved camera's shape, narrowed from the shapeless `projectMaps.viewport`. */
type SavedViewport = { bearing?: number; center?: [number, number]; pitch?: number; zoom?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows a stored center pair; anything but two numbers reads as absent. */
function centerPairOf(a: unknown, b: unknown): [number, number] | undefined {
  return typeof a === "number" && typeof b === "number" ? [a, b] : undefined;
}

/** True when the blob carries at least one scalar camera field. */
function hasCameraField(viewport: Record<string, unknown>): boolean {
  return (
    typeof viewport.zoom === "number" ||
    typeof viewport.bearing === "number" ||
    typeof viewport.pitch === "number"
  );
}

/** Narrows the stored viewport; a junk blob reads as absent (the extent fit takes over). */
function narrowSavedViewport(viewport: unknown): SavedViewport | undefined {
  if (!isRecord(viewport)) {
    return undefined;
  }
  const rawCenter = viewport.center,
    center =
      Array.isArray(rawCenter) && rawCenter.length === 2
        ? centerPairOf(rawCenter[0], rawCenter[1])
        : undefined;
  if (center === undefined && !hasCameraField(viewport)) {
    return undefined;
  }
  return {
    bearing: typeof viewport.bearing === "number" ? viewport.bearing : undefined,
    center,
    pitch: typeof viewport.pitch === "number" ? viewport.pitch : undefined,
    zoom: typeof viewport.zoom === "number" ? viewport.zoom : undefined,
  };
}

/** One placed group's `layers.get` query options (the spread lives here, out of the map callback). */
function groupQueryOf(layerId: string, enabled: boolean) {
  const query = convexQuery(api.layers.get, { layerId });
  return { ...query, enabled };
}

/** The owned group placements' layer ids, in draw order — the group-details fan-out's keys. */
function ownedGroupLayerIds(placements: MapPlacement[]): string[] {
  const ids: string[] = [];
  for (const placement of placements) {
    if (placement.kind === "owned" && placement.layer.kind === "group") {
      ids.push(placement.layer.layerId);
    }
  }
  return ids;
}

/**
 * Tile sources per RENDER layer: every layer whose dataset renders from a
 * fresh archive gets its own `pmtiles://` instance in its own style (the
 * duplicates share the archive's HTTP cache). Hidden layers stay listed —
 * their source mounts with `visible: false` and the tile cache stays warm.
 */
function buildTileRenderLayers(
  renderLayers: RenderLayer[],
  tileSources: Array<{ schemaId: string; url: string }>,
): TileRenderLayer[] {
  const urlBySchema = new globalThis.Map(tileSources.map((tile) => [tile.schemaId, tile.url])),
    tiles: TileRenderLayer[] = [];
  for (const layer of renderLayers) {
    if (layer.datasetId === undefined) {
      continue;
    }
    const url = urlBySchema.get(layer.datasetId);
    if (url !== undefined) {
      tiles.push({ renderId: layer.renderId, schemaId: layer.datasetId, url });
    }
  }
  return tiles;
}

export const Route = createFileRoute("/projects/$projectId/maps/$mapId")({
  component: ProjectMapEditorPage,
});

const VIEWER_HINT = "Viewers have read-only access — an editor or owner can edit this map.";

function EditorSpinner() {
  return (
    <div className="flex justify-center items-center min-h-100">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}

/** The signed-out gate — `projects.get` throws for anonymous callers, which would otherwise render as an infinite spinner. */
function EditorSignInPrompt({ projectId }: { projectId: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderKanban />
          </EmptyMedia>
          <EmptyTitle>Sign in to continue</EmptyTitle>
          <EmptyDescription>
            Project maps are shared workspaces — sign in to see yours.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/signin">Sign in</RouterButton>
          <Link
            to="/projects/$projectId"
            params={{ projectId }}
            className="mt-3 block text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Back to the project
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
}

function EditorNotFoundCard({ projectId }: { projectId: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapIcon />
          </EmptyMedia>
          <EmptyTitle>Map not found</EmptyTitle>
          <EmptyDescription>
            It may have been deleted — or the project hasn't been shared with you.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/projects/$projectId" params={{ projectId }}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to the project
          </RouterButton>
        </EmptyContent>
      </Empty>
    </main>
  );
}

/**
 * The editor's mutation handlers, extracted so the page stays readable (the
 * retired standalone editor's useMapLayerActions shape, carried over).
 * `membershipIdByVersionId` is the workspace read's join — the linked-layer
 * flow pins a version (`layers.link` returns its id), and the placement
 * names the MEMBERSHIP whose artifactId is that version.
 */
function useMapLayerActions(
  mapId: string,
  projectId: string,
  membershipIdByVersionId: ReadonlyMap<string, string>,
) {
  const navigate = useNavigate(),
    addExisting = useMutation(api.projectMaps.addLayer),
    addDataset = useMutation(api.projectMaps.addDatasetToMap),
    addAll = useMutation(api.projectMaps.addAllDatasets),
    linkLayer = useMutation(api.layers.link),
    removeLayer = useMutation(api.projectMaps.removeLayer),
    setLayerVisibility = useMutation(api.projectMaps.setLayerVisibility),
    moveLayer = useMutation(api.projectMaps.moveLayer),
    deleteMap = useMutation(api.projectMaps.remove);

  const handleAddExistingLayer = async (layerMemberId: string): Promise<void> => {
    await addExisting({ layerMemberId, mapId });
    toast.success("Layer placed on the map.");
  };

  const handleAddDataset = async (datasetId: string): Promise<void> => {
    const outcome = await addDataset({ datasetId, mapId });
    toast.success(
      outcome.created
        ? "Imported and layered — the dataset joined the project with its own layer."
        : "Layered — the dataset's existing layer joined the map.",
    );
  };

  const handleAddAll = async (target: {
    collectionId?: string;
    groupId?: string;
  }): Promise<void> => {
    const outcome = await addAll({ ...target, mapId }),
      skipped =
        outcome.skipped === 0
          ? ""
          : ` — ${outcome.skipped} dataset${outcome.skipped === 1 ? "" : "s"} skipped (no geometry)`;
    toast.success(`Added ${outcome.added} ${outcome.added === 1 ? "layer" : "layers"}${skipped}.`);
  };

  const handleLinkAndPlace = async (sourceLayerId: string): Promise<void> => {
    const versionId = await linkLayer({ layerId: sourceLayerId, projectId }),
      membershipId = membershipIdByVersionId.get(versionId);
    if (membershipId === undefined) {
      toast.error(
        "Linked, but the placement couldn't find the new membership — reopen the map to place it.",
      );
      return;
    }
    await addExisting({ layerMemberId: membershipId, mapId });
    toast.success("Layer linked into the project and placed on the map.");
  };

  const handleRemoveLayer = async (mapLayerId: string): Promise<void> => {
    await removeLayer({ mapLayerId });
    toast.success("Layer removed from the map.");
  };

  const handleToggleVisibility = async (mapLayerId: string, visible: boolean): Promise<void> => {
    await setLayerVisibility({ mapLayerId, visible });
  };

  const handleMoveLayer = async (mapLayerId: string, direction: "up" | "down"): Promise<void> => {
    await moveLayer({ direction, mapLayerId });
  };

  const handleDeleteMap = async (): Promise<void> => {
    await deleteMap({ mapId });
    toast.success("Map deleted.");
    await navigate({
      params: { projectId },
      search: { view: "maps" },
      to: "/projects/$projectId",
    });
  };

  return {
    handleAddAll,
    handleAddDataset,
    handleAddExistingLayer,
    handleDeleteMap,
    handleLinkAndPlace,
    handleMoveLayer,
    handleRemoveLayer,
    handleToggleVisibility,
  };
}

// oxlint-disable-next-line eslint/complexity -- the editor composes the read set, the canvas, the panel, the style panel, and the sheets; ad hoc splitting risks these render paths (the retired editor's precedent).
function ProjectMapEditorPage() {
  const { mapId, projectId } = Route.useParams(),
    // The auth gate renders BEFORE the query state: anonymous callers' query
    // throws, and without this branch that shows as an infinite spinner.
    { isAuthenticated, isLoading: authLoading } = useConvexAuth(),
    authed = !authLoading && isAuthenticated,
    workspace = useQuery({ ...convexQuery(api.projects.get, { projectId }), enabled: authed })
      .data,
    maps = useQuery({ ...convexQuery(api.projectMaps.list, { projectId }), enabled: authed }).data,
    placementsQuery = useQuery({
      ...convexQuery(api.projectMaps.layers, { mapId }),
      enabled: authed,
    }),
    projectLayers = useQuery({ ...convexQuery(api.layers.list, { projectId }), enabled: authed })
      .data,
    datasetsQuery = useQuery({
      ...convexQuery(api.schemas.listSummaries, { limit: 1000 }),
      enabled: authed,
    }),
    collections = useQuery({ ...convexQuery(api.collections.list, {}), enabled: authed }).data,
    groups = useQuery({ ...convexQuery(api.groups.list, { limit: 500 }), enabled: authed }).data,
    [pickerOpen, setPickerOpen] = useState(false),
    otherProjects = useQuery({
      ...convexQuery(api.projects.list, {}),
      enabled: authed && pickerOpen,
    }).data,
    [editingMap, setEditingMap] = useState(false),
    [pendingDeleteMap, setPendingDeleteMap] = useState(false),
    [pendingRemovePlacement, setPendingRemovePlacement] = useState<MapPlacement | undefined>(
      undefined,
    ),
    [selectedPlacementId, setSelectedPlacementId] = useState<string | undefined>(undefined),
    [savingStyle, setSavingStyle] = useState(false),
    [arrivedTileSchemaIds, setArrivedTileSchemaIds] = useState<Set<string>>(() => new Set()),
    mapRef = useRef<MapLibreMap | null>(null),
    updateLayer = useMutation(api.layers.update),
    setLayerVisible = useMutation(api.layers.setVisible),
    saveView = useMutation(api.projectMaps.update);

  // Everything below derives PLAINLY from the query results (no manual
  // memo chains — the React Compiler's lane), and every hook call sits above
  // the page's early returns (Rules of Hooks): during the loading state the
  // derivations run on empty inputs and the gates below discard them.
  const placements = placementsQuery.data ?? [],
    datasets = datasetsQuery.data ?? [],
    workspaceArtifacts = workspace === null || workspace === undefined ? [] : workspace.artifacts,
    datasetIdByMembershipId = new globalThis.Map<string, string>(),
    membershipIdByVersionId = new globalThis.Map<string, string>();
  for (const artifact of workspaceArtifacts) {
    if (artifact.artifactKind === "dataset") {
      datasetIdByMembershipId.set(artifact._id, artifact.artifactId);
    } else if (artifact.artifactKind === "layer") {
      membershipIdByVersionId.set(artifact.artifactId, artifact._id);
    }
  }
  const groupDetailById = useQueries({
      queries: ownedGroupLayerIds(placements).map((layerId) => groupQueryOf(layerId, authed)),
      combine: (results) => {
        const byId = new globalThis.Map<string, LayerDetail>(),
          groupIds = ownedGroupLayerIds(placements);
        for (const [index, result] of results.entries()) {
          const layerId = groupIds[index],
            detail = result.data;
          if (layerId !== undefined && detail !== null && detail !== undefined) {
            byId.set(layerId, detail);
          }
        }
        return byId;
      },
    }),
    renderLayers = effectiveRenderLayers(placements, groupDetailById, datasetIdByMembershipId),
    visibleRenderIds = new Set(
      renderLayers.filter((layer) => layer.visible).map((layer) => layer.renderId),
    ),
    // ALL render layers' datasets subscribe geometry (visible or not) —
    // toggling a layer on is an instant render filter, not a refetch.
    geometrySubscriptionIds = datasetIdsOf(renderLayers),
    sourceBySchema = useTileArchiveSources(
      geospatialDatasetsFor(geometrySubscriptionIds, datasets),
    ),
    split = splitSchemaIdsByDecision(geometrySubscriptionIds, sourceBySchema),
    // Only the ROW-path datasets stream geometry pages; tile-path datasets
    // cost zero row traffic (the whole point of the archive path).
    geometryFeed = useGeometriesBySchemas(split.rowSchemaIds),
    tileRenderLayers = buildTileRenderLayers(renderLayers, split.tileSources),
    tileSchemaIds = split.tileSources.map((tile) => tile.schemaId),
    keyedGeometries = keyedGeometryRows(
      withEmptyRows(geometryFeed.servedGeometries),
      renderIdsByDatasetIdOf(renderLayers),
    ),
    geometriesComplete = isLayersWorkspaceComplete(
      geometryFeed.geometries,
      split.sourcesPending,
      tileSchemaIds,
      arrivedTileSchemaIds,
    ),
    actions = useMapLayerActions(mapId, projectId, membershipIdByVersionId);

  if (authLoading) {
    return <EditorSpinner />;
  }
  if (!isAuthenticated) {
    return <EditorSignInPrompt projectId={projectId} />;
  }
  if (
    workspace === null ||
    workspace === undefined ||
    maps === undefined ||
    placementsQuery.data === undefined ||
    projectLayers === undefined ||
    datasetsQuery.data === undefined ||
    collections === undefined ||
    groups === undefined
  ) {
    // workspace === null is the not-found answer; the shared spinner here
    // covers only the still-loading case (resolved again right below).
    if (workspace === null) {
      return <EditorNotFoundCard projectId={projectId} />;
    }
    return <EditorSpinner />;
  }

  const map = maps === undefined ? undefined : maps.find((row) => row._id === mapId);
  if (map === undefined) {
    return <EditorNotFoundCard projectId={projectId} />;
  }

  const canWrite = workspace.project.role === "owner" || workspace.project.role === "editor",
    // This map's datasets only — the canvas frames its one-shot viewport from
    // these stored extents, so unrelated app datasets must not widen it.
    datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    mapDatasets = geometrySubscriptionIds.flatMap((schemaId) => {
      const dataset = datasetById.get(schemaId);
      return dataset === undefined ? [] : [dataset];
    }),
    renderIdDatasetMap = datasetIdByRenderId(renderLayers),
    savedViewport = narrowSavedViewport(map.viewport),
    selectedPlacement =
      selectedPlacementId === undefined
        ? undefined
        : placements.find((placement) => placement._id === selectedPlacementId),
    // Picker inputs (the sheet's module-level builder does the shaping).
    placedMemberIds = new Set(placements.map((placement) => placement.layerMemberId)),
    styledMemberIds = new Set(
      projectLayers.flatMap((layer) =>
        layer.kind === "data" && layer.datasetMemberId !== undefined ? [layer.datasetMemberId] : [],
      ),
    ),
    memberDatasetIds = new Set(
      workspaceArtifacts.flatMap((artifact) =>
        artifact.artifactKind === "dataset" ? [artifact.artifactId] : [],
      ),
    ),
    memberDatasets = workspaceArtifacts.flatMap((artifact) => {
      if (artifact.artifactKind !== "dataset" || artifact.state.kind !== "dataset") {
        return [];
      }
      const summary = artifact.state.summary;
      return summary.kind === "geospatial"
        ? [
            {
              datasetId: artifact.artifactId,
              geometryType: summary.geometryType,
              membershipId: artifact._id,
              title: summary.title,
            },
          ]
        : [];
    }),
    otherProjectOptions =
      otherProjects === undefined
        ? []
        : otherProjects
            .filter((project) => project._id !== projectId)
            .map((project) => ({ _id: project._id, title: project.title }));

  const saveStyle = async (draft: { name: string; style: LayerStyle }): Promise<void> => {
    if (selectedPlacement === undefined || selectedPlacement.kind !== "owned") {
      return;
    }
    setSavingStyle(true);
    try {
      await updateLayer({
        layerId: selectedPlacement.layer.layerId,
        name: draft.name,
        style: storedStyleOf(draft.style),
      });
      toast.success("Style saved — the map draws it now.");
    } catch (error) {
      toast.error(errorMessage(error, "Failed to save the style."));
    } finally {
      setSavingStyle(false);
    }
  };

  const handleToggleChild = async (childLayerId: string, visible: boolean): Promise<void> => {
    try {
      await setLayerVisible({ layerId: childLayerId, visible });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to toggle the layer."));
    }
  };

  const handleSaveView = async (): Promise<void> => {
    const camera = mapRef.current;
    if (camera === null) {
      return;
    }
    const center = camera.getCenter();
    try {
      await saveView({
        mapId,
        viewport: {
          bearing: camera.getBearing(),
          center: [center.lng, center.lat],
          pitch: camera.getPitch(),
          zoom: camera.getZoom(),
        },
      });
      toast.success("View saved — the map opens here from now on.");
    } catch (error) {
      toast.error(errorMessage(error, "Failed to save the view."));
    }
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/projects" />}>Projects</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink
                  render={
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId }}
                      search={{ view: "maps" }}
                    />
                  }
                >
                  {workspace.project.title}
                </BreadcrumbLink>
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
          {map.description !== undefined && (
            <p className="mt-2 text-lg text-muted-foreground">{map.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!canWrite}
            title={canWrite ? "Save the current camera as the map's opening view" : VIEWER_HINT}
            onClick={() => {
              void handleSaveView();
            }}
          >
            <Camera className="mr-2 h-4 w-4" />
            Save view
          </Button>
          <Button
            variant="outline"
            disabled={!canWrite}
            title={canWrite ? undefined : VIEWER_HINT}
            onClick={() => {
              setEditingMap(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            disabled={!canWrite}
            title={canWrite ? undefined : VIEWER_HINT}
            onClick={() => {
              setPendingDeleteMap(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button
            disabled={!canWrite}
            title={canWrite ? undefined : VIEWER_HINT}
            onClick={() => {
              setPickerOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add layer
          </Button>
        </div>
      </div>

      {placements.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>No layers yet</EmptyTitle>
            <EmptyDescription>
              Place one of the project's layers, layer a dataset, or import one from the catalog —
              each draws in this map's stored style.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              disabled={!canWrite}
              title={canWrite ? undefined : VIEWER_HINT}
              onClick={() => {
                setPickerOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add your first layer
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="relative h-[440px] w-full overflow-hidden rounded-lg border border-border lg:h-[640px]">
            {layersMapShouldMount(geometryFeed.servedGeometries, tileRenderLayers.length) && (
              <ProjectMapCanvas
                mapRef={mapRef}
                datasets={mapDatasets}
                datasetIdByRenderId={renderIdDatasetMap}
                keyedGeometries={keyedGeometries}
                renderLayers={renderLayers}
                savedViewport={savedViewport}
                sourcesPending={split.sourcesPending}
                tileRenderLayers={tileRenderLayers}
                visibleRenderIds={visibleRenderIds}
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
          <div className="flex flex-col gap-4">
            <MapLayerPanel
              canWrite={canWrite}
              groupDetailById={groupDetailById}
              placements={placements}
              selectedPlacementId={selectedPlacementId}
              viewerHint={VIEWER_HINT}
              onSelect={(placement) => {
                setSelectedPlacementId((prev) =>
                  prev === placement._id ? undefined : placement._id,
                );
              }}
              onToggleVisibility={(placement) => {
                void actions.handleToggleVisibility(placement._id, !placement.visible);
              }}
              onMove={(placement, direction) => {
                void actions.handleMoveLayer(placement._id, direction);
              }}
              onRemove={(placement) => {
                setPendingRemovePlacement(placement);
              }}
              onToggleChild={(child, currentlyVisible) => {
                if (child.childKind === "owned") {
                  void handleToggleChild(child.childLayerId, !currentlyVisible);
                }
              }}
            />
            <LayerStylePanel
              placement={selectedPlacement}
              saving={savingStyle}
              viewerHint={VIEWER_HINT}
              onSave={(draft) => {
                void saveStyle(draft);
              }}
            />
          </div>
        </div>
      )}
      {geometryFeed.loaders}

      <MapFormPanel map={map} open={editingMap} onOpenChange={setEditingMap} />

      <MapLayerPickerSheet
        canWrite={canWrite}
        catalogDatasets={datasets}
        collections={collections}
        groups={groups}
        memberDatasetIds={memberDatasetIds}
        memberDatasets={memberDatasets}
        open={pickerOpen}
        otherProjects={otherProjectOptions}
        placedMemberIds={placedMemberIds}
        projectLayers={projectLayers}
        styledMemberIds={styledMemberIds}
        viewerHint={VIEWER_HINT}
        onOpenChange={setPickerOpen}
        onAddExistingLayer={async (layerMemberId) => {
          await actions.handleAddExistingLayer(layerMemberId);
          setPickerOpen(false);
        }}
        onAddDataset={async (datasetId) => {
          await actions.handleAddDataset(datasetId);
          setPickerOpen(false);
        }}
        onAddAll={async (target) => {
          await actions.handleAddAll(target);
          setPickerOpen(false);
        }}
        onLinkAndPlace={async (sourceLayerId) => {
          await actions.handleLinkAndPlace(sourceLayerId);
          setPickerOpen(false);
        }}
      />

      <ConfirmDialog
        open={pendingDeleteMap}
        onOpenChange={setPendingDeleteMap}
        title={`Delete "${map.name}"?`}
        description="The map and its placements will be removed. The layers themselves stay in the project — other maps and the Layers tab are untouched."
        confirmLabel="Delete map"
        destructive
        onConfirm={() => {
          void actions.handleDeleteMap();
        }}
      />

      <ConfirmDialog
        open={pendingRemovePlacement !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemovePlacement(undefined);
          }
        }}
        title={`Remove "${
          pendingRemovePlacement === undefined || pendingRemovePlacement.kind === "missing"
            ? "this layer"
            : pendingRemovePlacement.layer.name
        }" from this map?`}
        description="The layer leaves the canvas but stays in the project — place it again any time."
        confirmLabel="Remove layer"
        destructive
        onConfirm={() => {
          if (pendingRemovePlacement !== undefined) {
            void actions.handleRemoveLayer(pendingRemovePlacement._id);
          }
          setPendingRemovePlacement(undefined);
        }}
      />
    </main>
  );
}

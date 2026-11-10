import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Button } from "@caden/ui/components/button";
import { Card, CardContent, CardDescription, CardTitle } from "@caden/ui/components/card";
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
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useQuery as useStoreQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  Database,
  ChevronUp,
  Ellipsis,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  Layers as LayersIcon,
  Link2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  MapPin,
  Pencil,
  Plus,
  Rocket,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { useLayerStyles } from "#/features/layer-styles";
import {
  LayersMap,
  pgDerivedToDerivedSummary,
  pgSummaryToDatasetSummary,
  renderTargetsForDerivedLayers,
  splitSchemaIdsByDecision,
  useGeometriesByPgDatasets,
  useTileArchiveSources,
} from "#/features/maps";
import { isPostgresDatasetId } from "#/lib/dataset-source";
import { errorMessage } from "#/lib/errors";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import { listDraftSummariesQueryOptions, listSummariesQueryOptions } from "#/lib/store/datasets";
import * as derivedStore from "#/lib/store/derived";
import * as layersStore from "#/lib/store/layers";
import type { LayerRow } from "#/lib/store/layers";
import * as mapsStore from "#/lib/store/maps";
import type { MapPlacementRow } from "#/lib/store/maps";

export const Route = createFileRoute("/projects/$projectId/maps/$mapId")({
  component: ProjectMapRoutePage,
});

/**
 * The in-project map editor (issue #257 — the project-centric train's
 * phase 3; ADR 0019; D2 — map creation lives in projects). The standalone
 * editor surface moved here from `/maps/$mapId` and retargeted to the
 * LAYERS model: placements name layer memberships, groups are layers
 * (nesting + the edit-time cycle guard), styling writes the layer row's
 * fragment (the styling hook rides the layer adapter), publish freezes
 * `layer_versions` rows, and linked layers are read-only pins with a
 * clone-to-owned escape. Route-local because the styling module is wired
 * only by routes (ADR 0011/0012's disposition, kept).
 *
 * A pre-migration Convex map id renders the shared archived state (the
 * provider is unmounted; issue #206). Rendering stays LIVE this phase: a
 * linked layer draws its frozen DEFINITION over its dataset's live data —
 * the version row carries the pin, and rendering from frozen rows is
 * [project 5]'s snapshot work (ADR 0019).
 */

function ProjectMapRoutePage() {
  const { mapId, projectId } = Route.useParams();
  if (isPostgresDatasetId(mapId) && isPostgresDatasetId(projectId)) {
    return <PgProjectMapEditor mapId={mapId} projectId={projectId} />;
  }
  return (
    <ArchivedConvexSurface
      description="This workspace served maps created before the Postgres migration. Pre-migration maps were retired with the old backend."
      homeTo="/projects"
      title="Convex maps are archived in this build"
    />
  );
}

/** The editor's draw-order color palette (the assigned-color round-robin; a styled layer's swatch color overrides it via the styling hook). */
const PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
  "#a855f7",
  "#eab308",
] as const;

/** How deep the entry resolver descends before stopping (the store's guard bounds real trees; this is the render-side belt). */
const RESOLVE_DEPTH_LIMIT = 16;

/** One resolved data entry: a placed (or group-child) data layer's render id + its ownership and visibility chain. */
interface DataEntry {
  /** The styled layer row (owned — styling writes here); undefined for linked entries (read-only). */
  layerId: string | undefined;
  layerName: string;
  linked: boolean;
  renderId: string;
  title: string;
  visible: boolean;
}

/** A nullable list as an empty list — row paths serve `undefined` before their first rows land. */
function withEmptyRows<T>(rows: T[] | undefined): T[] {
  return rows === undefined ? [] : rows;
}

/** The arrived-set update for one tile source's `idle` report (bails out when already present). */
function withArrivedTileSchema(prev: Set<string>, schemaId: string): Set<string> {
  if (prev.has(schemaId)) {
    return prev;
  }
  return new Set(prev).add(schemaId);
}

/** A style's stored fragment is drawable when it carries layer entries (an `{}` default is the assigned-color fallback). */
function hasDrawableStyle(style: unknown): boolean {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    return false;
  }
  // The record-shape guard above is the runtime check; the fragment's
  // layers array is the validators' contract (ADR 0019).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const record = style as Record<string, unknown>;
  return Array.isArray(record.layers) && record.layers.length > 0;
}

// The editor is one render graph (placements → memberships → layers →
// versions → datasets) whose branches ARE the map's states; the same
// disposition as the pre-layers route editor.
// oxlint-disable-next-line eslint/complexity -- the resolution graph is the workspace's real shape.
function PgProjectMapEditor({ mapId, projectId }: { mapId: string; projectId: string }) {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:layers"] });
    },
    run = async (job: () => Promise<unknown>, fallback: string): Promise<boolean> => {
      try {
        await job();
        invalidate();
        return true;
      } catch (error) {
        toast.error(errorMessage(error, fallback));
        return false;
      }
    },
    // ---- reads (hooks FIRST — every early return sits below them) ----
    map = useStoreQuery(mapsStore.getQueryOptions({ mapId })),
    placementsQuery = useStoreQuery(mapsStore.listPlacementsQueryOptions({ mapId })),
    projectLayersQuery = useQuery({ ...layersStore.listForProjectQueryOptions({ projectId }) }),
    pgSummaries = useStoreQuery(listSummariesQueryOptions()),
    // Owned drafts (the project's in-flight datasets) carry titles too — the add-dataset picker names them.
    pgDraftSummaries = useStoreQuery(listDraftSummariesQueryOptions()),
    pgDerivedRows = useStoreQuery(derivedStore.summariesQueryOptions()),
    linkableVersionsQuery = useQuery({ ...layersStore.listLinkableVersionsQueryOptions() }),
    projectDatasetsQuery = useQuery({
      ...layersStore.listDatasetMembershipsQueryOptions({
        projectId,
      }),
    }),
    placements = placementsQuery.data ?? [],
    projectLayers = projectLayersQuery.data ?? [],
    layersById = new globalThis.Map(projectLayers.map((layer) => [layer.id, layer])),
    membershipIds = [
      ...new Set(
        placements
          .map((placement) => placement.layerMemberId)
          .concat(
            projectLayers.flatMap((layer) =>
              layer.datasetMemberId === null ? [] : [layer.datasetMemberId],
            ),
          ),
      ),
    ],
    membershipsQuery = useQuery({
      queryKey: ["pg:layers", "artifactsByIds", { ids: membershipIds }],
      queryFn: async () => await layersStore.artifactsByIds({ ids: membershipIds }),
      enabled: membershipIds.length > 0,
    }),
    memberships = new globalThis.Map(
      (membershipsQuery.data ?? []).map((membership) => [membership.id, membership]),
    ),
    // Linked placements name layer_versions rows — resolve the ones the map shows.
    linkedVersionIds = [
      ...new Set(
        placements.flatMap((placement) => {
          const membership = memberships.get(placement.layerMemberId);
          return membership !== undefined &&
            membership.artifactKind === "layer" &&
            membership.role === "linked"
            ? [membership.artifactId]
            : [];
        }),
      ),
    ],
    versionsQuery = useQuery({
      queryKey: ["pg:layers", "versionsByIds", { ids: linkedVersionIds }],
      queryFn: async () =>
        await Promise.all(
          linkedVersionIds.map(async (versionId) => {
            return await layersStore.getVersion({ versionId });
          }),
        ),
      enabled: linkedVersionIds.length > 0,
    }),
    versionsById = new globalThis.Map(
      (versionsQuery.data ?? []).flatMap((version) =>
        version === null ? [] : [[version.id, version] as const],
      ),
    ),
    placedGroupIds = placements.flatMap((placement) => {
      const membership = memberships.get(placement.layerMemberId);
      if (membership === undefined || membership.role !== "owned") {
        return [];
      }
      const layer = layersById.get(membership.artifactId);
      return layer !== undefined && layer.kind === "group" ? [layer.id] : [];
    }),
    childrenQuery = useQuery({
      ...layersStore.listChildrenForGroupsQueryOptions({ groupIds: placedGroupIds }),
    }),
    childrenLists = new globalThis.Map<string, layersStore.LayerChildRow[]>();
  for (const child of childrenQuery.data ?? []) {
    const list = childrenLists.get(child.groupId) ?? [];
    list.push(child);
    childrenLists.set(child.groupId, list);
  }

  const derivedSummaries =
      pgDerivedRows.data === undefined
        ? undefined
        : pgDerivedRows.data.map(pgDerivedToDerivedSummary),
    // Published + the project's owned drafts: a project map renders its in-flight datasets too.
    allSummaries =
      pgSummaries.data === undefined || pgDraftSummaries.data === undefined
        ? undefined
        : [...pgSummaries.data, ...pgDraftSummaries.data],
    datasetsDocs =
      allSummaries === undefined ? undefined : allSummaries.map(pgSummaryToDatasetSummary),
    renderableDerived =
      derivedSummaries === undefined || datasetsDocs === undefined
        ? undefined
        : renderTargetsForDerivedLayers(derivedSummaries, datasetsDocs),
    datasetTitleById = new globalThis.Map((allSummaries ?? []).map((row) => [row.id, row.title])),
    // The add-dataset picker only offers rows that can draw: geospatial
    // datasets (derived stays offered — its geometry resolves at render time
    // and the summaries projection carries no geometry flag for it).
    // Undefined while the summaries load, so the sheet never flashes empty.
    geospatialDatasetIds =
      allSummaries === undefined
        ? undefined
        : new Set(allSummaries.filter((row) => row.isGeospatial).map((row) => row.id)),
    derivedTitleById = new globalThis.Map(
      // The Convex doc's branded id flattens to its string value (the PG
      // ids the editor resolves are plain strings).
      (derivedSummaries ?? []).map((summary) => [String(summary._id), summary.title]),
    ),
    // ---- editor state ----
    [editingMap, setEditingMap] = useState(false),
    [sidebarOpen, setSidebarOpen] = useState(true),
    [addOpen, setAddOpen] = useState(false),
    [groupOpen, setGroupOpen] = useState(false),
    [linkOpen, setLinkOpen] = useState(false),
    [pendingDeleteMap, setPendingDeleteMap] = useState(false),
    [childAddGroupId, setChildAddGroupId] = useState<string | undefined>(undefined),
    [pendingRemove, setPendingRemove] = useState<
      | {
          label: string;
          run: () => Promise<unknown>;
        }
      | undefined
    >(undefined),
    [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set()),
    toggleCollapsed = (key: string): void => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    };

  /** Flattens one placed layer into its data entries (groups recurse; linked rows resolve through their frozen pin). */
  // The kind ladder (owned data / owned group / linked) plus the visibility
  // chain IS the resolver's contract; splitting it would scatter one walk
  // across helpers with shared closures.
  // oxlint-disable-next-line eslint/complexity -- the resolver walk is the contract, stated once.
  function entriesOfLayer(
    artifactId: string,
    role: "owned" | "linked",
    visible: boolean,
    depth: number,
  ): DataEntry[] {
    if (depth > RESOLVE_DEPTH_LIMIT) {
      return [];
    }
    if (role === "linked") {
      const version = versionsById.get(artifactId);
      if (version === undefined || !visible) {
        return [];
      }
      // The frozen pin's dataset (the definition renders over its live data
      // this phase — ADR 0019).
      const pin =
          typeof version.dataset === "object" &&
          version.dataset !== null &&
          !Array.isArray(version.dataset)
            ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record guard above is the runtime check; publishLayer stamps the pin's shape.
              (version.dataset as Record<string, unknown>)
            : undefined,
        sourceMemberId =
          pin === undefined || typeof pin.sourceMemberId !== "string"
            ? undefined
            : pin.sourceMemberId,
        sourceMember = sourceMemberId === undefined ? undefined : memberships.get(sourceMemberId);
      if (sourceMember === undefined) {
        return [];
      }
      const title =
        datasetTitleById.get(sourceMember.artifactId) ??
        derivedTitleById.get(sourceMember.artifactId) ??
        "Linked layer";
      return [
        {
          layerId: undefined,
          layerName: `${title} · ${version.versionLabel}`,
          linked: true,
          renderId: sourceMember.artifactId,
          title,
          visible,
        },
      ];
    }
    const layer = layersById.get(artifactId);
    if (layer === undefined) {
      return [];
    }
    if (layer.kind === "group") {
      return entriesOfGroup(layer, visible, depth + 1);
    }
    if (!visible || layer.datasetMemberId === null) {
      return [];
    }
    const member = memberships.get(layer.datasetMemberId);
    if (member === undefined) {
      return [];
    }
    const title =
      datasetTitleById.get(member.artifactId) ??
      derivedTitleById.get(member.artifactId) ??
      layer.name;
    return [
      {
        layerId: layer.id,
        layerName: layer.name,
        linked: false,
        renderId: member.artifactId,
        title,
        visible: layer.visible,
      },
    ];
  }

  /** A group's children (owned children gate on their own layer-wide visible; linked children are always drawn). */
  function entriesOfGroup(group: LayerRow, visible: boolean, depth: number): DataEntry[] {
    if (!visible) {
      return [];
    }
    const children = childrenLists.get(group.id) ?? [],
      out: DataEntry[] = [];
    for (const child of children) {
      const childVisible =
        child.childKind === "linked"
          ? visible
          : visible &&
            (() => {
              const childLayer = layersById.get(child.childLayerId);
              return childLayer === undefined ? true : childLayer.visible;
            })();
      out.push(...entriesOfLayer(child.childLayerId, child.childKind, childVisible, depth));
    }
    return out;
  }

  // ---- the render inputs (computed pre-guard with safe defaults) ----
  const dataEntries = placements.flatMap((placement) => {
      const membership = memberships.get(placement.layerMemberId);
      if (membership === undefined) {
        return [];
      }
      return entriesOfLayer(membership.artifactId, membership.role, placement.visible, 0);
    }),
    visibleEntries = dataEntries.filter((entry) => entry.visible),
    schemaIds = [...new Set(visibleEntries.map((entry) => entry.renderId))],
    colorBySchema = new globalThis.Map<string, string>(
      schemaIds.map((schemaId, index) => [schemaId, PALETTE[index % PALETTE.length] ?? "#3b82f6"]),
    ),
    mapDatasets = (datasetsDocs ?? []).filter((dataset) => schemaIds.includes(dataset._id)),
    pgDecisionRows: DatasetSummaryRow[] = (allSummaries ?? []).filter(
      (row) => schemaIds.includes(row.id) && row.isGeospatial && row.geometryType !== null,
    ),
    decisions = useTileArchiveSources(pgDecisionRows),
    derivedRowIds = schemaIds.filter((schemaId) =>
      renderableDerived === undefined ? false : renderableDerived.has(schemaId),
    ),
    split = splitSchemaIdsByDecision(schemaIds, decisions, derivedRowIds),
    pgRowIds = split.rowSchemaIds.filter((schemaId) => isPostgresDatasetId(schemaId)),
    pgFan = useGeometriesByPgDatasets(pgRowIds),
    geometries = pgFan.geometries,
    servedGeometries = pgFan.servedGeometries,
    [arrivedTileSchemaIds, setArrivedTileSchemaIds] = useState<Set<string>>(() => new Set()),
    geometriesComplete =
      geometries !== undefined &&
      !split.sourcesPending &&
      split.tileSources.every((source) => arrivedTileSchemaIds.has(source.schemaId)),
    entrySourceOf = (renderId: string): string => {
      const derivedSource =
        renderableDerived === undefined ? undefined : renderableDerived.get(renderId);
      return derivedSource ?? renderId;
    },
    // The styling hook rides the layer adapter (ADR 0019): owned placed
    // layers' fragments, render-keyed by their dataset id; linked rows are
    // read-only (the save/reset callbacks refuse them).
    layerStyles = useLayerStyles({
      colorBySchema,
      entrySourceFor: (renderId) => entrySourceOf(renderId),
      geometryTypeFor: (renderId) => {
        const sourceId = entrySourceOf(renderId),
          dataset = (datasetsDocs ?? []).find((item) => item._id === sourceId);
        return dataset === undefined ? undefined : dataset.geometryType;
      },
      resetStyle: async ({ renderId }) => {
        const entry = dataEntries.find((candidate) => candidate.renderId === renderId);
        if (entry === undefined || entry.layerId === undefined) {
          throw new Error("Linked layers are read-only — clone the layer to restyle it.");
        }
        await layersStore.update({ layerId: entry.layerId, style: {} });
      },
      saved: dataEntries.flatMap((entry) => {
        if (entry.layerId === undefined) {
          return [];
        }
        const layer = layersById.get(entry.layerId);
        return layer !== undefined && layer.kind === "data" && hasDrawableStyle(layer.style)
          ? [{ renderId: entry.renderId, style: layer.style }]
          : [];
      }),
      saveStyle: async ({ renderId, style }) => {
        const entry = dataEntries.find((candidate) => candidate.renderId === renderId);
        if (entry === undefined || entry.layerId === undefined) {
          throw new Error("Linked layers are read-only — clone the layer to restyle it.");
        }
        await layersStore.update({ layerId: entry.layerId, style });
      },
      renderIds: schemaIds,
      tileRenderIds: new Set(split.tileSources.map((source) => source.schemaId)),
    }),
    styledColorBySchema = layerStyles.colorBySchema;

  if (
    map.data === undefined ||
    placementsQuery.data === undefined ||
    projectLayersQuery.data === undefined ||
    allSummaries === undefined ||
    pgDerivedRows.data === undefined ||
    renderableDerived === undefined ||
    datasetsDocs === undefined
  ) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  const mapData = map.data;
  if (mapData === null) {
    return (
      <Card className="mx-auto mt-8 max-w-md py-12 text-center">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Map not found</CardTitle>
          <CardDescription className="mb-4">
            The map doesn't exist — or you're not a member of its project.
          </CardDescription>
          <Link params={{ projectId }} to="/projects/$projectId">
            <Button>Back to project</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const hasPlacements = placements.length > 0,
    addedDatasetMembershipIds = new Set(
      dataEntries.flatMap((entry) => {
        if (entry.layerId === undefined) {
          return [];
        }
        const layer = layersById.get(entry.layerId);
        return layer === undefined || layer.datasetMemberId === null ? [] : [layer.datasetMemberId];
      }),
    ),
    linkedPlacementVersionIds = new Set(
      placements.flatMap((placement) => {
        const membership = memberships.get(placement.layerMemberId);
        return membership !== undefined &&
          membership.artifactKind === "layer" &&
          membership.role === "linked"
          ? [membership.artifactId]
          : [];
      }),
    );

  return (
    <div className="flex min-h-[480px] flex-col md:h-[calc(100vh-7rem)]">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-primary">
            <LayersIcon className="h-6 w-6" />
            {mapData.name}
          </h1>
          {mapData.description !== null && (
            <p className="text-sm text-muted-foreground">{mapData.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setEditingMap(true);
            }}
            variant="outline"
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            onClick={() => {
              setPendingDeleteMap(true);
            }}
            variant="outline"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button
            onClick={() => {
              setAddOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add dataset
          </Button>
          <Button
            onClick={() => {
              setLinkOpen(true);
            }}
            variant="outline"
          >
            <Link2 className="mr-2 h-4 w-4" />
            Link layer
          </Button>
          <Button
            onClick={() => {
              setGroupOpen(true);
            }}
            variant="outline"
          >
            <FolderPlus className="mr-2 h-4 w-4" />
            New group
          </Button>
        </div>
      </div>

      {!hasPlacements ? (
        <div className="p-6">
          <Empty className="min-h-80 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayersIcon />
              </EmptyMedia>
              <EmptyTitle>No layers yet</EmptyTitle>
              <EmptyDescription>
                Add a project dataset — an owned layer is created for it in one click — or link a
                published layer from another project. Nothing is copied.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                onClick={() => {
                  setAddOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add your first dataset
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {pgFan.loaders}
          <aside
            className={`${sidebarOpen ? "flex" : "hidden"} w-full shrink-0 flex-col gap-3 overflow-y-auto border-b border-border bg-background p-3 md:w-[320px] xl:w-[360px] md:border-r md:border-b-0`}
          >
            {layerStyles.panel}
            <PgPlacementsPanel
              childrenLists={childrenLists}
              collapsedGroups={collapsedGroups}
              invalidate={invalidate}
              layersById={layersById}
              memberships={memberships}
              onAddChild={setChildAddGroupId}
              onRemove={setPendingRemove}
              placements={placements}
              projectId={projectId}
              run={run}
              toggleCollapsed={toggleCollapsed}
              versionsById={versionsById}
            />
          </aside>
          <div className="relative h-[440px] min-w-0 flex-1 overflow-hidden md:h-auto">
            <Button
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? "Collapse layers sidebar" : "Expand layers sidebar"}
              className="absolute top-3 left-3 z-20 bg-card/95 shadow-sm backdrop-blur-sm"
              onClick={() => {
                setSidebarOpen((open) => !open);
                // MapLibre sizes to its container: nudge it once the layout settles.
                globalThis.setTimeout(() => {
                  globalThis.dispatchEvent(new Event("resize"));
                }, 50);
              }}
              size="icon"
              title={sidebarOpen ? "Collapse layers sidebar" : "Expand layers sidebar"}
              variant="outline"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </Button>
            {(servedGeometries !== undefined || split.tileSources.length > 0) && (
              <LayersMap
                chainLayers={[]}
                colorBySchema={styledColorBySchema}
                datasets={mapDatasets}
                derivedLayers={derivedRowIds.flatMap((derivedId) => {
                  const source =
                    renderableDerived === undefined ? undefined : renderableDerived.get(derivedId);
                  return source === undefined ? [] : [{ derivedId, sourceSchemaId: source }];
                })}
                extension={layerStyles.extension}
                geometries={withEmptyRows(servedGeometries)}
                onTileSourceIdle={(schemaId) => {
                  setArrivedTileSchemaIds((prev) => withArrivedTileSchema(prev, schemaId));
                }}
                rowsPending={geometries === undefined && pgRowIds.length > 0}
                relationRuntime={{ projectId }}
                sourcesPending={split.sourcesPending}
                tileSources={split.tileSources}
                titlesById={
                  // Dataset titles first, derived over them — the relation
                  // runtime names off-map relation ends from the same read.
                  new globalThis.Map([...datasetTitleById, ...derivedTitleById])
                }
                visibleSchemaIds={new Set(visibleEntries.map((entry) => entry.renderId))}
              />
            )}
            {!geometriesComplete && (
              <div className="absolute top-3 right-3 z-20 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                {pgRowIds.length > 1
                  ? `Loading features — ${pgFan.completedCount} of ${pgFan.datasetCount} layers…`
                  : "Loading features…"}
              </div>
            )}
          </div>
          {layerStyles.loaders}
        </div>
      )}

      <PgMapFormDialog
        map={mapData}
        onOpenChange={setEditingMap}
        open={editingMap}
        onSubmit={async (args) => {
          await mapsStore.update({ description: args.description, mapId, name: args.name });
          invalidate();
        }}
      />

      <PgAddDatasetSheet
        geospatialDatasetIds={geospatialDatasetIds}
        invalidate={invalidate}
        mapId={mapId}
        memberships={projectDatasetsQuery.data ?? []}
        onOpenChange={setAddOpen}
        open={addOpen}
        placedMembershipIds={addedDatasetMembershipIds}
        projectId={projectId}
        run={run}
        titlesById={new globalThis.Map([...datasetTitleById, ...derivedTitleById])}
      />

      <PgLinkLayerSheet
        invalidate={invalidate}
        linkedVersionIds={linkedPlacementVersionIds}
        mapId={mapId}
        onOpenChange={setLinkOpen}
        open={linkOpen}
        projectId={projectId}
        run={run}
        versions={linkableVersionsQuery.data ?? []}
      />

      <PgNewGroupDialog
        invalidate={invalidate}
        mapId={mapId}
        onOpenChange={setGroupOpen}
        open={groupOpen}
        projectId={projectId}
        run={run}
      />

      <PgAddChildSheet
        groupLayerId={childAddGroupId ?? ""}
        invalidate={invalidate}
        layers={projectLayers}
        onClose={() => {
          setChildAddGroupId(undefined);
        }}
        open={childAddGroupId !== undefined}
        projectId={projectId}
        run={run}
        versions={linkableVersionsQuery.data ?? []}
      />

      <ConfirmDialog
        onConfirm={() => {
          if (pendingRemove !== undefined) {
            void run(pendingRemove.run, "Failed to remove.");
          }
          setPendingRemove(undefined);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemove(undefined);
          }
        }}
        open={pendingRemove !== undefined}
        title={pendingRemove === undefined ? "" : `Remove "${pendingRemove.label}"?`}
        description={
          pendingRemove === undefined
            ? ""
            : "It leaves the map. The layer itself stays in the project — place it again any time."
        }
        confirmLabel="Remove"
        destructive
      />

      <ConfirmDialog
        description="The map and its placements are removed. The project's layers and datasets stay put."
        onConfirm={() => {
          void (async () => {
            if (
              await run(async () => {
                await mapsStore.remove({ mapId });
              }, "Failed to delete map.")
            ) {
              toast.success("Map deleted.");
              await navigate({ params: { projectId }, to: "/projects/$projectId" });
            }
          })();
        }}
        onOpenChange={setPendingDeleteMap}
        open={pendingDeleteMap}
        title={`Delete "${mapData.name}"?`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The placements panel: one row per placement in draw order; groups expand
// to their children. Every write rides the stores and the editor's
// invalidate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The placements panel: one row per placement in draw order; groups expand
// to their children. Every write rides the stores and the editor's
// invalidate.
// ---------------------------------------------------------------------------

/** One placement row's body — the kind ladder (owned group / owned data / linked), the eye, the move/remove controls, and the row menu (publish, clone, remove-from-project). */
// The row renders every placement kind's honest state as one flat ladder —
// the same disposition as the pre-layers route editor's row.
// oxlint-disable-next-line eslint/complexity -- the per-kind ladder is the row's whole contract.
interface PanelProps {
  childrenLists: globalThis.Map<string, layersStore.LayerChildRow[]>;
  collapsedGroups: ReadonlySet<string>;
  invalidate: () => void;
  layersById: globalThis.Map<string, LayerRow>;
  memberships: globalThis.Map<string, layersStore.ArtifactRefRow>;
  onAddChild: (groupLayerId: string) => void;
  onRemove: (pending: { label: string; run: () => Promise<unknown> }) => void;
  placements: MapPlacementRow[];
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  toggleCollapsed: (key: string) => void;
  versionsById: globalThis.Map<string, layersStore.LayerVersionRow>;
}

// The row renders every placement kind's honest state as one flat ladder —
// the same disposition as the pre-layers route editor's row.
// oxlint-disable-next-line eslint/complexity -- the per-kind ladder is the row's whole contract.
function PlacementRowBody(
  props: PanelProps & {
    index: number;
    placement: MapPlacementRow;
  },
) {
  const { placement } = props,
    membership = props.memberships.get(placement.layerMemberId),
    linked = membership !== undefined && membership.role === "linked",
    layer =
      membership !== undefined && membership.role === "owned"
        ? props.layersById.get(membership.artifactId)
        : undefined,
    version = linked
      ? props.versionsById.get(membership === undefined ? "" : membership.artifactId)
      : undefined,
    name = linked
      ? `Linked layer · ${version === undefined ? "" : version.versionLabel}`
      : layer === undefined
        ? "Layer"
        : layer.name,
    isGroup = layer !== undefined && layer.kind === "group",
    expanded = isGroup && !props.collapsedGroups.has(placement.id),
    needsAttention = layer === undefined ? null : layer.needsAttention,
    // A data layer styles one project dataset — "View dataset" opens it in the shell.
    datasetMember =
      layer === undefined || layer.datasetMemberId === null
        ? undefined
        : props.memberships.get(layer.datasetMemberId),
    viewDatasetId =
      datasetMember !== undefined && datasetMember.artifactKind === "dataset"
        ? datasetMember.artifactId
        : undefined,
    [busy, setBusy] = useState<string | undefined>(),
    act = async (action: string, job: () => Promise<unknown>, success: string): Promise<void> => {
      setBusy(action);
      if (await props.run(job, "The action didn't land — you may not have access.")) {
        toast.success(success);
      }
      setBusy(undefined);
    };
  return (
    <>
      <div className="flex items-center gap-2">
        {isGroup ? (
          <button
            aria-label={expanded ? `Collapse "${name}"` : `Expand "${name}"`}
            className="flex h-6 w-6 shrink-0 items-center justify-center"
            onClick={() => {
              props.toggleCollapsed(placement.id);
            }}
            type="button"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
        {linked ? (
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : isGroup ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            if (isGroup) {
              props.toggleCollapsed(placement.id);
            }
          }}
          type="button"
        >
          <p className={`truncate text-sm ${placement.visible ? "" : "opacity-55"}`}>
            {name}
            {linked && version !== null && version !== undefined ? (
              <span className="ml-1 text-xs text-muted-foreground">{version.versionLabel}</span>
            ) : null}
          </p>
          {needsAttention !== null && (
            <p className="truncate text-xs text-amber-600" title={needsAttention}>
              Needs attention — {needsAttention}
            </p>
          )}
        </button>
        {layer !== undefined && layer.lifecycle === "published" && !linked && (
          <span className="shrink-0 text-xs text-muted-foreground">published</span>
        )}
        <Button
          aria-label={placement.visible ? `Hide "${name}"` : `Show "${name}"`}
          className="size-7"
          disabled={busy !== undefined}
          onClick={() => {
            void act(
              "eye",
              async () => {
                await mapsStore.setPlacementVisibility({
                  placementId: placement.id,
                  visible: !placement.visible,
                });
              },
              placement.visible ? "Hidden." : "Shown.",
            );
          }}
          size="icon"
          variant="ghost"
        >
          {placement.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button aria-label={`Actions for "${name}"`} size="icon" variant="ghost" />}
          >
            <Ellipsis className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={props.index === 0 || busy !== undefined}
              onClick={() => {
                void act(
                  "up",
                  async () => {
                    await mapsStore.movePlacement({ direction: "up", placementId: placement.id });
                  },
                  "",
                );
              }}
            >
              <ChevronUp className="mr-2 h-4 w-4" />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={props.index === props.placements.length - 1 || busy !== undefined}
              onClick={() => {
                void act(
                  "down",
                  async () => {
                    await mapsStore.movePlacement({ direction: "down", placementId: placement.id });
                  },
                  "",
                );
              }}
            >
              <ChevronDown className="mr-2 h-4 w-4" />
              Move down
            </DropdownMenuItem>
            {!linked && layer !== undefined && (
              <DropdownMenuItem
                onClick={() => {
                  void act(
                    "publish",
                    async () => {
                      const versionId = await layersStore.publishLayer({ layerId: layer.id });
                      if (versionId === null) {
                        throw new Error("The publish was denied.");
                      }
                    },
                    "Layer published — linkable and cloneable.",
                  );
                }}
              >
                <Rocket className="mr-2 h-4 w-4" />
                Publish{isGroup ? " (children first)" : ""}
              </DropdownMenuItem>
            )}
            {linked && version !== undefined && (
              <DropdownMenuItem
                onClick={() => {
                  void act(
                    "clone",
                    async () => {
                      const cloned = await layersStore.cloneLayer({
                        projectId: props.projectId,
                        sourceVersionId: version.id,
                      });
                      if (cloned === null) {
                        throw new Error("The clone was denied.");
                      }
                    },
                    "Cloned into the project as an owned draft.",
                  );
                }}
              >
                <LayersIcon className="mr-2 h-4 w-4" />
                Clone (editable copy)
              </DropdownMenuItem>
            )}
            {!linked && layer !== undefined && (
              <DropdownMenuItem
                onClick={() => {
                  props.onRemove({
                    label: name,
                    run: async () => {
                      await layersStore.remove({ layerId: layer.id });
                    },
                  });
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove from project
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                props.onRemove({
                  label: name,
                  run: async () => {
                    if (linked) {
                      await layersStore.unlinkLayer({ membershipId: placement.layerMemberId });
                    } else {
                      await mapsStore.removePlacement({ placementId: placement.id });
                    }
                  },
                });
              }}
            >
              <X className="mr-2 h-4 w-4" />
              {linked ? "Unlink from project" : "Remove from map"}
            </DropdownMenuItem>
            {viewDatasetId !== undefined && (
              <DropdownMenuItem
                render={
                  <Link
                    params={{ projectId: props.projectId, schemaId: viewDatasetId }}
                    to="/projects/$projectId/datasets/$schemaId"
                  />
                }
              >
                <Database className="mr-2 h-4 w-4" />
                View dataset
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isGroup && expanded && (
        <PgGroupChildren
          act={act}
          childList={
            props.childrenLists.get(membership === undefined ? "" : membership.artifactId) ?? []
          }
          groupLayerId={membership === undefined ? "" : membership.artifactId}
          layersById={props.layersById}
          onAddChild={() => {
            props.onAddChild(membership === undefined ? "" : membership.artifactId);
          }}
          onRemove={props.onRemove}
          run={props.run}
        />
      )}
    </>
  );
}

/** A placed group's children: owned child rows (eye toggles the child layer's own visible) + linked child rows (read-only), each with move/remove. */
function PgGroupChildren(props: {
  act: (action: string, job: () => Promise<unknown>, success: string) => Promise<void>;
  childList: layersStore.LayerChildRow[];
  groupLayerId: string;
  layersById: globalThis.Map<string, LayerRow>;
  onAddChild: () => void;
  onRemove: (pending: { label: string; run: () => Promise<unknown> }) => void;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1 border-l pl-3">
      {props.childList.map((child, index) => {
        const childLayer =
            child.childKind === "owned" ? props.layersById.get(child.childLayerId) : undefined,
          label =
            childLayer === undefined
              ? child.childKind === "linked"
                ? "Linked layer"
                : "Layer"
              : childLayer.name;
        return (
          <li
            className={`flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50 ${
              childLayer !== undefined && !childLayer.visible ? "opacity-55" : ""
            }`}
            key={child.id}
          >
            {child.childKind === "linked" ? (
              <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <p className="min-w-0 flex-1 truncate text-xs font-medium">{label}</p>
            {childLayer !== undefined && (
              <>
                <Button
                  aria-label={childLayer.visible ? `Hide "${label}"` : `Show "${label}"`}
                  className="size-7"
                  onClick={() => {
                    void props.act(
                      `eye-${child.id}`,
                      async () => {
                        await layersStore.update({
                          layerId: childLayer.id,
                          visible: !childLayer.visible,
                        });
                      },
                      childLayer.visible ? "Hidden." : "Shown.",
                    );
                  }}
                  size="icon"
                  variant="ghost"
                >
                  {childLayer.visible ? (
                    <Eye className="size-3.5" />
                  ) : (
                    <EyeOff className="size-3.5" />
                  )}
                </Button>
                <Button
                  aria-label={`Move "${label}" up`}
                  className="size-7"
                  disabled={index === 0}
                  onClick={() => {
                    void props.act(
                      `up-${child.id}`,
                      async () => {
                        await layersStore.moveChild({ childId: child.id, direction: "up" });
                      },
                      "",
                    );
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <ChevronUp className="size-3.5" />
                </Button>
                <Button
                  aria-label={`Remove "${label}" from the group`}
                  className="size-7"
                  onClick={() => {
                    void props.act(
                      `rm-${child.id}`,
                      async () => {
                        await layersStore.removeChild({ childId: child.id });
                      },
                      "Removed from the group.",
                    );
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              </>
            )}
          </li>
        );
      })}
      {props.childList.length === 0 && (
        <li className="px-2 py-1 text-xs text-muted-foreground">Empty group.</li>
      )}
      <li>
        <Button onClick={props.onAddChild} size="sm" variant="outline">
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add layer to group
        </Button>
      </li>
    </ul>
  );
}

/** The add-child sheet for one group: owned project layers (the cycle guard refuses an ancestor at write time) + published versions to link. */
function PgAddChildSheet(props: {
  groupLayerId: string;
  invalidate: () => void;
  layers: LayerRow[];
  onClose: () => void;
  open: boolean;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  versions: layersStore.LinkableVersionRow[];
}) {
  const [pendingId, setPendingId] = useState<string>(),
    ownedCandidates = props.layers.filter((layer) => layer.id !== props.groupLayerId),
    addOwned = async (childLayerId: string): Promise<void> => {
      setPendingId(childLayerId);
      if (
        await props.run(async () => {
          const child = await layersStore.addChild({
            childKind: "owned",
            childLayerId,
            groupId: props.groupLayerId,
          });
          if (child === null) {
            throw new Error("The child was denied.");
          }
        }, "Failed to add the layer — the cycle guard may have refused it.")
      ) {
        toast.success("Added to the group.");
        props.invalidate();
        props.onClose();
      }
      setPendingId(undefined);
    },
    addLinked = async (childLayerId: string): Promise<void> => {
      setPendingId(childLayerId);
      if (
        await props.run(async () => {
          const child = await layersStore.addChild({
            childKind: "linked",
            childLayerId,
            groupId: props.groupLayerId,
          });
          if (child === null) {
            throw new Error("The child was denied.");
          }
        }, "Failed to link the layer into the group.")
      ) {
        toast.success("Linked into the group (read-only at the frozen version).");
        props.invalidate();
        props.onClose();
      }
      setPendingId(undefined);
    };
  return (
    <Sheet onOpenChange={props.onClose} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to group</SheetTitle>
          <SheetDescription>
            Owned layers nest inside the group (the guard refuses cycles); published versions link
            read-only.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          <p className="text-sm font-semibold">Project layers</p>
          {ownedCandidates.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              No other layers in the project yet.
            </p>
          ) : (
            ownedCandidates.map((layer) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={layer.id}
                onClick={() => {
                  void addOwned(layer.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{layer.name}</span>
                {pendingId === layer.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
          <p className="mt-3 text-sm font-semibold">Published versions (link)</p>
          {props.versions.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              Nothing published yet.
            </p>
          ) : (
            props.versions.map((version) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={version.id}
                onClick={() => {
                  void addLinked(version.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {version.layer.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {version.versionLabel}
                    {version.layer.project === null ? "" : ` · ${version.layer.project.title}`}
                  </span>
                </span>
                {pendingId === version.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The panel shell (the route passes its resolved maps + the shared run/invalidate pair). */
function PgPlacementsPanel(props: PanelProps) {
  return (
    <section aria-label="Layers">
      <h2
        className="px-1 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        title="Draw order, top layer first — groups expand to their children"
      >
        Layers ({props.placements.length})
      </h2>
      <ul className="flex flex-col">
        {props.placements.map((placement, index) => (
          <li className="rounded-md px-1 py-1 hover:bg-muted/50" key={placement.id}>
            <PlacementRowBody index={index} placement={placement} {...props} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The map form (name + description) as a sheet — the old MapFormPanel's fields, the project route's back link. */
function PgMapFormDialog(props: {
  map: mapsStore.MapRow;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSubmit: (args: { description?: string; name: string }) => Promise<void>;
}) {
  const [name, setName] = useState(props.map.name),
    [description, setDescription] = useState(props.map.description ?? "");
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Edit map</SheetTitle>
          <SheetDescription>Name is the only required field.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="map-name">Name</Label>
            <Input
              id="map-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
              value={name}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="map-description">Description</Label>
            <Input
              id="map-description"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              value={description}
            />
          </div>
          <Button
            disabled={name.trim() === ""}
            onClick={() => {
              void props
                .onSubmit({
                  description: description.trim() === "" ? undefined : description,
                  name,
                })
                .then(() => {
                  props.onOpenChange(false);
                  toast.success("Map updated.");
                  return undefined;
                })
                .catch((error: unknown) => {
                  toast.error(errorMessage(error, "Failed to update the map."));
                });
            }}
          >
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The add-dataset sheet: the project's drawable memberships not yet placed — picking one mints the owned default-style layer (the auto-layer) and places it. */
function PgAddDatasetSheet(props: {
  /** Geospatial dataset ids, or undefined while the summaries load (no filtering then — never flash an empty sheet). */
  geospatialDatasetIds: ReadonlySet<string> | undefined;
  invalidate: () => void;
  mapId: string;
  memberships: layersStore.DatasetMembershipRow[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  placedMembershipIds: ReadonlySet<string>;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  titlesById: globalThis.Map<string, string>;
}) {
  const [pendingId, setPendingId] = useState<string>(),
    candidates = props.memberships.filter(
      (membership) =>
        // A plain table can never draw — offering it mints a dead layer
        // (#278). Derived stays: its geometry resolves at render time.
        !props.placedMembershipIds.has(membership.id) &&
        (membership.artifactKind === "derived" ||
          props.geospatialDatasetIds === undefined ||
          props.geospatialDatasetIds.has(membership.artifactId)),
    ),
    add = async (membershipId: string): Promise<void> => {
      setPendingId(membershipId);
      if (
        await props.run(async () => {
          const layerId = await layersStore.createForDataset({
            datasetMemberId: membershipId,
            projectId: props.projectId,
          });
          if (layerId === null) {
            throw new Error("The layer didn't mint — you may not have access.");
          }
          const membershipRow = await layersStore.membershipIdForLayer({ layerId });
          if (membershipRow === null) {
            throw new Error("The layer's membership didn't mint.");
          }
          const placement = await mapsStore.addPlacement({
            layerMemberId: membershipRow,
            mapId: props.mapId,
          });
          if (placement === null) {
            throw new Error("The placement was denied.");
          }
        }, "Failed to add the dataset.")
      ) {
        toast.success("Added — an owned layer was created and placed.");
        props.invalidate();
        props.onOpenChange(false);
      }
      setPendingId(undefined);
    };
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add dataset to map</SheetTitle>
          <SheetDescription>
            An owned layer with a default style is created for the dataset — restyle it from its
            row's menu.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          {candidates.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              {props.geospatialDatasetIds === undefined
                ? "Every project dataset is already placed — add more from the project's catalog."
                : "Nothing drawable to add — everything geospatial is placed, and plain tables need geometry before they can map."}
            </p>
          ) : (
            candidates.map((membership) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={membership.id}
                onClick={() => {
                  void add(membership.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {props.titlesById.get(membership.artifactId) ?? membership.artifactId}
                </span>
                {pendingId === membership.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The link-layer sheet: recent published layer versions across the viewer's visible projects; linking pins one read-only. */
function PgLinkLayerSheet(props: {
  invalidate: () => void;
  linkedVersionIds: ReadonlySet<string>;
  mapId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  versions: layersStore.LinkableVersionRow[];
}) {
  const [pendingId, setPendingId] = useState<string>(),
    candidates = props.versions.filter((version) => !props.linkedVersionIds.has(version.id)),
    link = async (versionId: string): Promise<void> => {
      setPendingId(versionId);
      if (
        await props.run(async () => {
          const membership = await layersStore.linkLayer({
            projectId: props.projectId,
            sourceVersionId: versionId,
          });
          if (membership === null) {
            throw new Error("The link was denied.");
          }
          const placement = await mapsStore.addPlacement({
            layerMemberId: membership.id,
            mapId: props.mapId,
          });
          if (placement === null) {
            throw new Error("The placement was denied.");
          }
        }, "Failed to link the layer.")
      ) {
        toast.success("Linked — a read-only pin at the published version.");
        props.invalidate();
        props.onOpenChange(false);
      }
      setPendingId(undefined);
    };
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Link a published layer</SheetTitle>
          <SheetDescription>
            A linked layer is read-only at its frozen version — clone it into an owned copy to
            restyle.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          {candidates.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              No published layers visible yet — publish one from a map first.
            </p>
          ) : (
            candidates.map((version) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={version.id}
                onClick={() => {
                  void link(version.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {version.layer.name}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {version.versionLabel}
                    {version.layer.project === null ? "" : ` · ${version.layer.project.title}`}
                  </span>
                </span>
                {pendingId === version.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The new-group dialog: a name is the only required field; the group lands placed on this map. */
function PgNewGroupDialog(props: {
  invalidate: () => void;
  mapId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(""),
    create = async (): Promise<void> => {
      if (
        await props.run(async () => {
          const layerId = await layersStore.create({
            kind: "group",
            name: name.trim() === "" ? "New group" : name.trim(),
            projectId: props.projectId,
          });
          if (layerId === null) {
            throw new Error("The group didn't mint — you may not have access.");
          }
          const membershipRow = await layersStore.membershipIdForLayer({ layerId });
          if (membershipRow === null) {
            throw new Error("The group's membership didn't mint.");
          }
          const placement = await mapsStore.addPlacement({
            layerMemberId: membershipRow,
            mapId: props.mapId,
          });
          if (placement === null) {
            throw new Error("The placement was denied.");
          }
        }, "Failed to create the group.")
      ) {
        toast.success("Group added to the map.");
        props.invalidate();
        props.onOpenChange(false);
      }
    };
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>New group layer</SheetTitle>
          <SheetDescription>
            Groups are layers — they hold other layers and groups (cycles are refused), and they
            publish/link/clone exactly like data layers.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
              value={name}
            />
          </div>
          <Button
            onClick={() => {
              void create();
            }}
          >
            Create and place
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

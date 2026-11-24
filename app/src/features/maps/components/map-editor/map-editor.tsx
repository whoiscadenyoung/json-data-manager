import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Button } from "@caden/ui/components/button";
import { Card, CardContent, CardDescription, CardTitle } from "@caden/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { useQuery as useStoreQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  Database,
  Ellipsis,
  FolderPlus,
  Layers as LayersIcon,
  Link2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useLayerStyles } from "#/features/layer-styles";
import { errorMessage } from "#/lib/errors";
import { largestRelatedSet } from "#/lib/relation-phrases";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import { listDraftSummariesQueryOptions, listSummariesQueryOptions } from "#/lib/store/datasets";
import * as layersStore from "#/lib/store/layers";
import type { LayerRow } from "#/lib/store/layers";
import * as mapsStore from "#/lib/store/maps";
import * as relationsStore from "#/lib/store/relations";

import { splitSchemaIdsByDecision, useTileArchiveSources } from "../../lib/layer-source";
import { popupInputsOf, usePopupFieldsFor } from "../../lib/popup-fields";
import { LayersMap } from "../layers-map";
import { useGeometriesByPgDatasets } from "../pg-geometries-loader";
import { pgSummaryToDatasetSummary } from "../pg-layer-rows";
import { PopupFieldsDialog } from "../popup-fields-dialog";
import {
  RELATED_SET_PREFIX,
  groupRelatedLayers,
  mapDatasetIdsOf,
  relatedLayerNodesOf,
  relationNotesOf,
} from "./layer-grouping";
import { LayerOutline } from "./layer-outline";
import { LayerSettings } from "./layer-settings";
import {
  PgAddChildSheet,
  PgAddDatasetSheet,
  PgLinkLayerSheet,
  PgMapFormDialog,
  PgNewGroupDialog,
} from "./map-editor-sheets";
import type { LayerSelection, PendingRemoval, RunWrite } from "./types";

/**
 * The project's map editor: one full-height workspace. The header names the
 * map and holds "Add layer" and the map's own actions; the layer list sits
 * left of the map; the settings of the selected layer dock on the right.
 *
 * Placements name layer memberships, groups are layers, styling writes the
 * layer row's fragment, publishing freezes `layer_versions` rows, and linked
 * layers are read-only pins that can be copied into owned ones (ADR 0019).
 * A linked layer draws its frozen definition over its dataset's live data.
 */

/** The editor's draw-order color palette (the assigned-color round-robin; a styled layer's swatch color overrides it via the styling hook). */
const NO_LIVE_IDS: ReadonlySet<string> = new globalThis.Set();

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

/** MapLibre sizes to its container: nudge it once a panel opens or closes. */
function nudgeMap(): void {
  globalThis.setTimeout(() => {
    globalThis.dispatchEvent(new Event("resize"));
  }, 50);
}

// The editor is one render graph (placements → memberships → layers →
// versions → datasets) whose branches ARE the map's states; the same
// disposition as the pre-layers route editor.
// oxlint-disable-next-line eslint/complexity -- the resolution graph is the workspace's real shape.
export function ProjectMapEditor({ mapId, projectId }: { mapId: string; projectId: string }) {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:layers"] });
    },
    run: RunWrite = async (job, fallback) => {
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
    // #294: the declared relations among the datasets this map's layers draw.
    mapDatasetIds = mapDatasetIdsOf(placements, memberships, layersById),
    mapRelationsQuery = useQuery(
      relationsStore.listForDatasetsQueryOptions({ datasetIds: mapDatasetIds }),
    ),
    // #342: the largest relation-connected set of placed data layers — the
    // "group related layers" proposal. Undefined until the relations read
    // lands; empty set = nothing to propose.
    relatedDatasetSet = largestRelatedSet(mapRelationsQuery.data ?? [], mapDatasetIds),
    // #342: the placed owned-data layers for exactly the proposed datasets,
    // plus the group's display name — undefined until the relations read
    // lands or fewer than two datasets relate.
    relatedLayerNodes = relatedLayerNodesOf(placements, memberships, layersById, relatedDatasetSet),
    relatedGroupProposal =
      relatedLayerNodes === undefined
        ? undefined
        : {
            name:
              RELATED_SET_PREFIX +
              relatedLayerNodes
                .map((node) => node.name)
                .slice(0, 3)
                .join(" + ") +
              (relatedLayerNodes.length > 3 ? " + …" : ""),
            nodes: relatedLayerNodes,
          },
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

  // Published + the project's owned drafts: a project map renders its in-flight datasets too.
  const allSummaries =
      pgSummaries.data === undefined || pgDraftSummaries.data === undefined
        ? undefined
        : [...pgSummaries.data, ...pgDraftSummaries.data],
    datasetsDocs =
      allSummaries === undefined ? undefined : allSummaries.map(pgSummaryToDatasetSummary),
    datasetTitleById = new globalThis.Map((allSummaries ?? []).map((row) => [row.id, row.title])),
    // The add-dataset picker only offers rows that can draw: geospatial
    // datasets.
    // Undefined while the summaries load, so the sheet never flashes empty.
    geospatialDatasetIds =
      allSummaries === undefined
        ? undefined
        : new Set(allSummaries.filter((row) => row.isGeospatial).map((row) => row.id)),
    // ---- editor state ----
    [editingMap, setEditingMap] = useState(false),
    [sidebarOpen, setSidebarOpen] = useState(true),
    [addOpen, setAddOpen] = useState(false),
    [groupOpen, setGroupOpen] = useState(false),
    [linkOpen, setLinkOpen] = useState(false),
    [pendingDeleteMap, setPendingDeleteMap] = useState(false),
    [childAddGroupId, setChildAddGroupId] = useState<string | undefined>(undefined),
    [pendingRemove, setPendingRemove] = useState<PendingRemoval>(),
    [selection, setSelection] = useState<LayerSelection>(),
    [popupLayerId, setPopupLayerId] = useState<string>(),
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
      const title = datasetTitleById.get(sourceMember.artifactId) ?? "Linked layer";
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
    const title = datasetTitleById.get(member.artifactId) ?? layer.name;
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
    split = splitSchemaIdsByDecision(schemaIds, decisions),
    popupFieldsFor = usePopupFieldsFor(
      popupInputsOf(dataEntries, layersById),
      new Set((allSummaries ?? []).filter((row) => row.kind === "view").map((row) => row.id)),
    ),
    pgRowIds = split.rowSchemaIds,
    pgFan = useGeometriesByPgDatasets(pgRowIds),
    liveViewIds = pgFan.liveIds ?? NO_LIVE_IDS,
    geometries = pgFan.geometries,
    servedGeometries = pgFan.servedGeometries,
    [arrivedTileSchemaIds, setArrivedTileSchemaIds] = useState<Set<string>>(() => new Set()),
    geometriesComplete =
      geometries !== undefined &&
      !split.sourcesPending &&
      split.tileSources.every((source) => arrivedTileSchemaIds.has(source.schemaId)),
    // The styling hook rides the layer adapter (ADR 0019): owned placed
    // layers' fragments, render-keyed by their dataset id; linked rows are
    // read-only (the save/reset callbacks refuse them).
    layerStyles = useLayerStyles({
      colorBySchema,
      entrySourceFor: (renderId) => renderId,
      geometryTypeFor: (renderId) => {
        const dataset = (datasetsDocs ?? []).find((item) => item._id === renderId);
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
          <Link params={{ projectId }} to="/projects/$projectId/maps">
            <Button>Back to maps</Button>
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

  // ---- selection: the settings panel and the style controls follow it ----
  const datasetOfLayer = (
      layerId: string | undefined,
    ): { id: string; title: string } | undefined => {
      const layer = layerId === undefined ? undefined : layersById.get(layerId),
        member =
          layer === undefined || layer.datasetMemberId === null
            ? undefined
            : memberships.get(layer.datasetMemberId);
      return member === undefined || member.artifactKind !== "dataset"
        ? undefined
        : {
            id: member.artifactId,
            title: datasetTitleById.get(member.artifactId) ?? "Dataset",
          };
    },
    // A row that was removed takes its selection with it.
    rowIds = new Set([
      ...placements.map((placement) => placement.id),
      ...(childrenQuery.data ?? []).map((child) => child.id),
    ]),
    activeSelection =
      selection !== undefined && rowIds.has(selection.rowId) ? selection : undefined,
    selectedLayer =
      activeSelection === undefined || activeSelection.layerId === undefined
        ? undefined
        : layersById.get(activeSelection.layerId),
    selectedDataset =
      activeSelection === undefined ? undefined : datasetOfLayer(activeSelection.layerId),
    popupLayer = popupLayerId === undefined ? undefined : layersById.get(popupLayerId),
    popupDataset = datasetOfLayer(popupLayerId),
    relationNotes = relationNotesOf(mapRelationsQuery.data ?? [], mapDatasetIds, (id) => {
      return datasetTitleById.get(id) ?? "another dataset";
    }),
    select = (next: LayerSelection | undefined): void => {
      const dataset =
        next !== undefined && next.kind === "data" ? datasetOfLayer(next.layerId) : undefined;
      setSelection(next);
      layerStyles.edit(
        next === undefined || dataset === undefined
          ? undefined
          : { renderId: dataset.id, title: next.name },
      );
      if ((next === undefined) !== (activeSelection === undefined)) {
        nudgeMap();
      }
    },
    movePlacementTo = (placementId: string, toIndex: number): void => {
      const fromIndex = placements.findIndex((placement) => placement.id === placementId),
        steps = toIndex - fromIndex;
      if (fromIndex === -1 || steps === 0) {
        return;
      }
      void run(async () => {
        for (let step = 0; step < Math.abs(steps); step += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- each swap reads the order the last one wrote.
          await mapsStore.movePlacement({ direction: steps < 0 ? "up" : "down", placementId });
        }
      }, "Failed to reorder the layers.");
    },
    cloneVersion = (versionId: string): void => {
      void (async () => {
        if (
          await run(async () => {
            const cloned = await layersStore.cloneLayer({ projectId, sourceVersionId: versionId });
            if (cloned === null) {
              throw new Error("The copy wasn't made. You may not have access.");
            }
          }, "Failed to copy the layer.")
        ) {
          toast.success("Copied into this project as a layer you can edit.");
        }
      })();
    };

  return (
    <div className="flex min-h-[480px] flex-col md:h-[calc(100vh-7rem)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {hasPlacements ? (
          <Button
            aria-expanded={sidebarOpen}
            aria-label={sidebarOpen ? "Hide the layer list" : "Show the layer list"}
            onClick={() => {
              setSidebarOpen((open) => !open);
              nudgeMap();
            }}
            size="icon-sm"
            title={sidebarOpen ? "Hide the layer list" : "Show the layer list"}
            variant="ghost"
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold" title={mapData.name}>
            {mapData.name}
          </h1>
          {mapData.description !== null && (
            <p className="truncate text-xs text-muted-foreground" title={mapData.description}>
              {mapData.description}
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" type="button" />}>
            <Plus />
            Add layer
            <ChevronDown className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem
              onClick={() => {
                setAddOpen(true);
              }}
            >
              <Database />
              Dataset from this project
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setLinkOpen(true);
              }}
            >
              <Link2 />
              Published layer from another project
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setGroupOpen(true);
              }}
            >
              <FolderPlus />
              New group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button aria-label="Map actions" size="icon-sm" type="button" variant="ghost" />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onClick={() => {
                setEditingMap(true);
              }}
            >
              <Pencil />
              Edit name and description
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setPendingDeleteMap(true);
              }}
              variant="destructive"
            >
              <Trash2 />
              Delete map…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
                Add one of this project's datasets to draw it on the map, or link a layer another
                project has published. Nothing is copied.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  onClick={() => {
                    setAddOpen(true);
                  }}
                >
                  <Plus />
                  Add a dataset
                </Button>
                <Button
                  onClick={() => {
                    setLinkOpen(true);
                  }}
                  variant="outline"
                >
                  <Link2 />
                  Link a published layer
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {pgFan.loaders}
          <aside
            className={`${sidebarOpen ? "flex" : "hidden"} w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-background p-2 md:w-[280px] md:border-r md:border-b-0`}
          >
            <LayerOutline
              childrenLists={childrenLists}
              collapsedGroups={collapsedGroups}
              colorOf={(datasetId) => styledColorBySchema.get(datasetId)}
              layersById={layersById}
              memberships={memberships}
              onAddChild={setChildAddGroupId}
              onGroupRelated={
                relatedGroupProposal === undefined
                  ? undefined
                  : () => {
                      const proposal = relatedGroupProposal;
                      void run(async () => {
                        await groupRelatedLayers({
                          layers: proposal.nodes.map((node) => ({
                            layerId: node.layerId,
                            placementId: node.placementId,
                          })),
                          mapId,
                          name: proposal.name,
                          projectId,
                        });
                      }, "Failed to group the related layers.");
                    }
              }
              onMove={movePlacementTo}
              onPopupFields={setPopupLayerId}
              onRemove={setPendingRemove}
              onSelect={select}
              placements={placements}
              projectId={projectId}
              run={run}
              selectedRowId={activeSelection === undefined ? undefined : activeSelection.rowId}
              toggleCollapsed={toggleCollapsed}
              versionsById={versionsById}
            />
          </aside>
          <div className="relative h-[440px] min-w-0 flex-1 overflow-hidden md:h-auto">
            {(servedGeometries !== undefined || split.tileSources.length > 0) && (
              <LayersMap
                chainLayers={[]}
                liveViewIds={liveViewIds}
                popupFieldsFor={popupFieldsFor}
                colorBySchema={styledColorBySchema}
                datasets={mapDatasets}
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
                  // The relation runtime names off-map relation ends from the
                  // same read.
                  datasetTitleById
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
          {activeSelection !== undefined && (
            <LayerSettings
              childCount={
                selectedLayer === undefined ? 0 : (childrenLists.get(selectedLayer.id) ?? []).length
              }
              dataset={selectedDataset}
              layer={selectedLayer}
              onAddChild={setChildAddGroupId}
              onClone={cloneVersion}
              onClose={() => {
                select(undefined);
              }}
              onPopupFields={setPopupLayerId}
              projectId={projectId}
              relationNotes={
                selectedDataset === undefined ? [] : (relationNotes.get(selectedDataset.id) ?? [])
              }
              selection={activeSelection}
              styling={layerStyles}
              version={
                activeSelection.versionId === undefined
                  ? undefined
                  : versionsById.get(activeSelection.versionId)
              }
            />
          )}
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
        titlesById={datasetTitleById}
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

      {popupLayer !== undefined && popupDataset !== undefined && (
        <PopupFieldsDialog
          datasetId={popupDataset.id}
          onOpenChange={(open) => {
            if (!open) {
              setPopupLayerId(undefined);
            }
          }}
          onSave={async (popup) => {
            if (
              await run(async () => {
                await layersStore.update({ layerId: popupLayer.id, popup });
              }, "Failed to save the popup fields.")
            ) {
              toast.success(
                popup === null ? "Popup fields follow the view." : "Popup fields saved.",
              );
            }
          }}
          open
          popup={popupLayer.popup}
        />
      )}

      <ConfirmDialog
        confirmLabel={pendingRemove === undefined ? "Remove" : pendingRemove.confirmLabel}
        description={pendingRemove === undefined ? "" : pendingRemove.description}
        destructive
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
        title={pendingRemove === undefined ? "" : pendingRemove.title}
      />

      <ConfirmDialog
        confirmLabel="Delete map"
        description="The map and its layer list are deleted. The project's layers and datasets stay."
        destructive
        onConfirm={() => {
          void (async () => {
            if (
              await run(async () => {
                await mapsStore.remove({ mapId });
              }, "Failed to delete map.")
            ) {
              toast.success("Map deleted.");
              await navigate({ params: { projectId }, to: "/projects/$projectId/maps" });
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

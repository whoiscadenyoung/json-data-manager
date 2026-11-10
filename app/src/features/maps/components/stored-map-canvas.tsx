import { Badge } from "@caden/ui/components/badge";
import { Skeleton } from "@caden/ui/components/skeleton";
import { Spinner } from "@caden/ui/components/spinner";
import { useQuery, useQuery as useStoreQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useLayerStyles } from "#/features/layer-styles";
import { isPostgresDatasetId } from "#/lib/dataset-source";
import { listSummariesQueryOptions } from "#/lib/store/datasets";
import * as layersStore from "#/lib/store/layers";
import * as mapsStore from "#/lib/store/maps";

import { splitSchemaIdsByDecision, useTileArchiveSources } from "../lib/layer-source";
import { NO_DERIVED_TITLES, NO_RENDERABLE_DERIVED } from "../lib/map-layers";
import { LayersMap } from "./layers-map";
import { useGeometriesByPgDatasets } from "./pg-geometries-loader";
import { pgSummaryToDatasetSummary } from "./pg-layer-rows";

/**
 * A stored project map, rendered — the app builder's map widget canvas
 * (issue #259; D7). This is the editor's resolution graph (placements →
 * memberships → layers → versions → datasets), scoped to read-only
 * rendering: no panels, no edit actions, styling writes refuse (the widget
 * restyles through the map editor, never inline). Linked placements draw
 * their frozen definition over the dataset's live rows — the same live
 * rendering the editor shipped in #257; frozen-row rendering is the
 * published view's (the app snapshot work).
 *
 * Mounted in two phases: the outer component reads the map row (the
 * project id rides it), the inner one runs the graph — every hook list
 * stays flat and unconditional (the react-compiler rules).
 */

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
  /** The styled layer row (owned — the styling hook reads its fragment); undefined for linked entries (read-only). */
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

/** The map row's read: pending → skeleton, missing/denied → the not-found card. */
export function StoredMapCanvas({ mapId }: { mapId: string }) {
  const map = useStoreQuery(mapsStore.getQueryOptions({ mapId }));
  if (map.isPending) {
    return <Skeleton className="size-full rounded-none" />;
  }
  if (map.isError || map.data === null) {
    return (
      <div className="flex size-full items-center justify-center bg-muted/40 px-6 text-center text-sm text-muted-foreground">
        This map isn&apos;t available — it may have been deleted, or its project isn&apos;t shared
        with you.
      </div>
    );
  }
  return <StoredMapBody key={map.data.id} mapId={map.data.id} projectId={map.data.projectId} />;
}

// The canvas is the editor's render graph minus its panels; the branches are
// the map's states (owned/group/linked × row/tile), each rendered once, here.
// oxlint-disable-next-line eslint/complexity -- the resolution graph is the canvas's real shape.
function StoredMapBody({ mapId, projectId }: { mapId: string; projectId: string }) {
  const placementsQuery = useStoreQuery(mapsStore.listPlacementsQueryOptions({ mapId })),
    projectLayersQuery = useQuery({
      ...layersStore.listForProjectQueryOptions({ projectId }),
    }),
    pgSummaries = useStoreQuery(listSummariesQueryOptions()),
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

  const datasetsDocs =
      pgSummaries.data === undefined ? undefined : pgSummaries.data.map(pgSummaryToDatasetSummary),
    renderableDerived: globalThis.Map<string, string> = NO_RENDERABLE_DERIVED,
    datasetTitleById = new globalThis.Map(
      (pgSummaries.data ?? []).map((row) => [row.id, row.title]),
    ),
    derivedTitleById = NO_DERIVED_TITLES;

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
  function entriesOfGroup(
    group: layersStore.LayerRow,
    visible: boolean,
    depth: number,
  ): DataEntry[] {
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
    pgDecisionRows = (pgSummaries.data ?? []).filter(
      (row) => schemaIds.includes(row.id) && row.isGeospatial && row.geometryType !== null,
    ),
    decisions = useTileArchiveSources(pgDecisionRows),
    derivedRowIds = schemaIds.filter((schemaId) =>
      renderableDerived === undefined ? false : renderableDerived.has(schemaId),
    ),
    split = splitSchemaIdsByDecision(schemaIds, decisions, derivedRowIds),
    pgRowIds = split.rowSchemaIds.filter((schemaId) => isPostgresDatasetId(schemaId)),
    pgFan = useGeometriesByPgDatasets(pgRowIds),
    [arrivedTileSchemaIds, setArrivedTileSchemaIds] = useState<Set<string>>(() => new Set()),
    geometriesComplete =
      pgFan.geometries !== undefined &&
      !split.sourcesPending &&
      split.tileSources.every((source) => arrivedTileSchemaIds.has(source.schemaId)),
    entrySourceOf = (renderId: string): string => {
      const derivedSource =
        renderableDerived === undefined ? undefined : renderableDerived.get(renderId);
      return derivedSource ?? renderId;
    },
    // The styling hook rides the layer adapter (ADR 0019): placed layers'
    // fragments, render-keyed by their dataset id. The canvas restyles
    // nothing — a styling write happens in the map editor.
    layerStyles = useLayerStyles({
      colorBySchema,
      entrySourceFor: (renderId) => entrySourceOf(renderId),
      geometryTypeFor: (renderId) => {
        const sourceId = entrySourceOf(renderId),
          dataset = (datasetsDocs ?? []).find((item) => item._id === sourceId);
        return dataset === undefined ? undefined : dataset.geometryType;
      },
      resetStyle: async () => {
        throw new Error("Restyle this layer in the map editor — the app shows the saved map.");
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
      saveStyle: async () => {
        throw new Error("Restyle this layer in the map editor — the app shows the saved map.");
      },
      renderIds: schemaIds,
      tileRenderIds: new Set(split.tileSources.map((source) => source.schemaId)),
    }),
    styledColorBySchema = layerStyles.colorBySchema;

  if (
    placementsQuery.data === undefined ||
    projectLayersQuery.data === undefined ||
    pgSummaries.data === undefined ||
    datasetsDocs === undefined
  ) {
    return <Skeleton className="size-full rounded-none" />;
  }

  const shouldMount = pgFan.servedGeometries !== undefined || split.tileSources.length > 0;
  return (
    <div className="relative size-full overflow-hidden">
      {pgFan.loaders}
      {shouldMount ? (
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
          geometries={withEmptyRows(pgFan.servedGeometries)}
          onTileSourceIdle={(schemaId) => {
            setArrivedTileSchemaIds((prev) => withArrivedTileSchema(prev, schemaId));
          }}
          relationRuntime={{ projectId }}
          sourcesPending={split.sourcesPending}
          tileSources={split.tileSources}
          titlesById={new globalThis.Map([...datasetTitleById, ...derivedTitleById])}
          visibleSchemaIds={new Set(visibleEntries.map((entry) => entry.renderId))}
        />
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
      {!geometriesComplete && (
        <Badge variant="outline" className="absolute top-3 left-3 z-10 bg-card shadow-sm">
          <Spinner data-icon="inline-start" />
          Loading features…
        </Badge>
      )}
    </div>
  );
}

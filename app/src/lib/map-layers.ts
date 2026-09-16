import type { FunctionReturnType } from "convex/server";

import { api } from "#convex/_generated/api";

export type MapLayerDoc = FunctionReturnType<typeof api.maps.listLayers>[number];
export type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];
export type GroupSummary = FunctionReturnType<typeof api.groups.list>[number];
export type MembershipRow = FunctionReturnType<
  typeof api.collections.listSchemaCollections
>[number];
export type MapLayerOverride = FunctionReturnType<typeof api.maps.listMapLayerOverrides>[number];

export type LayerTargetType = "collection" | "group" | "dataset";

/** A child entry under an expandable layer: a group (with its member datasets) or a single dataset. */
export type LayerChild =
  | {
      childKey: string;
      datasets: Array<{ color: string; dataset: DatasetSummary }>;
      group: GroupSummary;
      kind: "group";
    }
  | { childKey: string; color?: string; dataset: DatasetSummary; kind: "dataset" };

export function datasetChildKey(schemaId: string): string {
  return `dataset:${schemaId}`;
}

export function groupChildKey(groupId: string): string {
  return `group:${groupId}`;
}

/** Cycled per dataset so each shows up as a distinct color on the map/legend. */
export const DATASET_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export function colorForIndex(index: number) {
  return DATASET_COLORS[index % DATASET_COLORS.length];
}

/**
 * Expands each layer to the geospatial dataset ids it currently contributes:
 * a dataset layer to itself; a group layer via member datasets' `groupId`; a
 * collection layer via its `schemaCollections` memberships PLUS every
 * dataset of a group living in that collection (a group joins a collection
 * as a single unit and brings its members along — see CollectionAddSheet).
 * Membership changes flow through on every read — nothing is denormalized.
 * Standard datasets never render geometry, so a target holding only
 * standard datasets expands to an empty list.
 */
export function expandLayerDatasets(
  layers: MapLayerDoc[],
  datasets: DatasetSummary[],
  memberships: MembershipRow[],
  groups: GroupSummary[],
): Map<string, string[]> {
  const datasetById = new Map(datasets.map((dataset) => [dataset._id, dataset])),
    groupIdsByCollection = new Map<string, string[]>();
  for (const group of groups) {
    if (group.collectionId === undefined) {
      continue;
    }
    const existing = groupIdsByCollection.get(group.collectionId);
    if (existing !== undefined) {
      existing.push(group._id);
    } else {
      groupIdsByCollection.set(group.collectionId, [group._id]);
    }
  }

  const expanded = new Map<string, string[]>();
  for (const layer of layers) {
    let rawSchemaIds: string[];
    if (layer.targetType === "collection") {
      const collectionGroupIds = new Set(groupIdsByCollection.get(layer.targetId) ?? []);
      rawSchemaIds = [
        ...memberships
          .filter((membership) => membership.collectionId === layer.targetId)
          .map((membership) => membership.schemaId),
        ...datasets
          .filter(
            (dataset) => dataset.groupId !== undefined && collectionGroupIds.has(dataset.groupId),
          )
          .map((dataset) => dataset._id),
      ];
    } else if (layer.targetType === "group") {
      rawSchemaIds = datasets
        .filter((dataset) => dataset.groupId === layer.targetId)
        .map((dataset) => dataset._id);
    } else {
      rawSchemaIds = [layer.targetId];
    }
    expanded.set(
      layer._id,
      rawSchemaIds.filter((schemaId) => {
        const dataset = datasetById.get(schemaId);
        return dataset !== undefined && dataset.kind === "geospatial";
      }),
    );
  }
  return expanded;
}

/**
 * Assigns each dataset a stable color: datasets are taken in draw order
 * (layer order, then order within the layer), first appearance wins, and the
 * assignment ignores visibility — so toggling a layer never reshuffles the
 * colors of the ones left on screen.
 */
export function assignDatasetColors(
  layers: MapLayerDoc[],
  expanded: Map<string, string[]>,
): Map<string, string> {
  const colorBySchema = new Map<string, string>();
  for (const layer of layers) {
    for (const schemaId of expanded.get(layer._id) ?? []) {
      if (!colorBySchema.has(schemaId)) {
        colorBySchema.set(schemaId, colorForIndex(colorBySchema.size));
      }
    }
  }
  return colorBySchema;
}

function datasetsByGroupId(datasets: DatasetSummary[]): globalThis.Map<string, DatasetSummary[]> {
  const byGroup = new globalThis.Map<string, DatasetSummary[]>();
  for (const dataset of datasets) {
    if (dataset.groupId !== undefined) {
      const members = byGroup.get(dataset.groupId);
      if (members !== undefined) {
        members.push(dataset);
      } else {
        byGroup.set(dataset.groupId, [dataset]);
      }
    }
  }
  return byGroup;
}

function directSchemaIdsByCollection(
  memberships: MembershipRow[],
): globalThis.Map<string, Set<string>> {
  const byCollection = new globalThis.Map<string, Set<string>>();
  for (const membership of memberships) {
    const ids = byCollection.get(membership.collectionId);
    if (ids !== undefined) {
      ids.add(membership.schemaId);
    } else {
      byCollection.set(membership.collectionId, new Set([membership.schemaId]));
    }
  }
  return byCollection;
}

/** A collection layer's children: its groups (members nested beneath) plus directly-joined datasets not already shown under a member group. */
function collectionLayerChildren(
  layer: MapLayerDoc,
  datasets: DatasetSummary[],
  groups: GroupSummary[],
  directIds: Set<string>,
  datasetsByGroup: globalThis.Map<string, DatasetSummary[]>,
  colorBySchema: Map<string, string>,
): LayerChild[] {
  const collectionGroups = groups.filter((group) => group.collectionId === layer.targetId),
    collectionGroupIds = new Set(collectionGroups.map((group) => group._id)),
    children: LayerChild[] = [];
  for (const group of collectionGroups) {
    children.push({
      childKey: groupChildKey(group._id),
      datasets: (datasetsByGroup.get(group._id) ?? []).map((dataset) => ({
        color: colorBySchema.get(dataset._id) ?? "#3b82f6",
        dataset,
      })),
      group,
      kind: "group",
    });
  }
  for (const dataset of datasets) {
    if (
      directIds.has(dataset._id) &&
      !(dataset.groupId !== undefined && collectionGroupIds.has(dataset.groupId))
    ) {
      children.push({
        childKey: datasetChildKey(dataset._id),
        color: colorBySchema.get(dataset._id),
        dataset,
        kind: "dataset",
      });
    }
  }
  return children;
}

/**
 * Builds each layer's child tree for the layer panel: a collection layer's
 * children are its groups (with their member datasets nested) plus its
 * directly-joined datasets — excluding datasets already shown under a member
 * group — and a group layer's children are its member datasets. Children
 * mirror live membership like the map itself; standard (non-geospatial)
 * datasets appear too, they just contribute no geometry.
 */
export function buildLayerChildren(
  layers: MapLayerDoc[],
  datasets: DatasetSummary[],
  memberships: MembershipRow[],
  groups: GroupSummary[],
  colorBySchema: Map<string, string>,
): Map<string, LayerChild[]> {
  const datasetsByGroup = datasetsByGroupId(datasets),
    directIdsByCollection = directSchemaIdsByCollection(memberships),
    childDataset = (dataset: DatasetSummary): LayerChild => ({
      childKey: datasetChildKey(dataset._id),
      color: colorBySchema.get(dataset._id),
      dataset,
      kind: "dataset",
    }),
    childrenByLayer = new globalThis.Map<string, LayerChild[]>();
  for (const layer of layers) {
    let children: LayerChild[] = [];
    if (layer.targetType === "collection") {
      children = collectionLayerChildren(
        layer,
        datasets,
        groups,
        directIdsByCollection.get(layer.targetId) ?? new Set<string>(),
        datasetsByGroup,
        colorBySchema,
      );
    } else if (layer.targetType === "group") {
      for (const dataset of datasetsByGroup.get(layer.targetId) ?? []) {
        children.push(childDataset(dataset));
      }
    }
    childrenByLayer.set(layer._id, children);
  }
  return childrenByLayer;
}

/** Groups the override rows by layer, then by `childKey`. */
export function overridesByLayerId(
  overrides: MapLayerOverride[],
): globalThis.Map<string, globalThis.Map<string, boolean>> {
  const byLayer = new globalThis.Map<string, globalThis.Map<string, boolean>>();
  for (const override of overrides) {
    const layerOverrides = byLayer.get(override.layerId);
    if (layerOverrides !== undefined) {
      layerOverrides.set(override.childKey, override.visible);
    } else {
      byLayer.set(override.layerId, new globalThis.Map([[override.childKey, override.visible]]));
    }
  }
  return byLayer;
}

/**
 * Effective visibility of one child within one layer: the layer itself must
 * be visible, the child's own override (if any) must not hide it, and — for
 * a dataset inside a collection layer — its member group child must not be
 * hidden (a hidden group hides its datasets regardless of their own
 * overrides).
 */
/** Per-layer child visibility overrides, keyed by layer id then `childKey`. */
export type MapLayerOverrideMap = globalThis.Map<string, globalThis.Map<string, boolean>>;

/**
 * Whether one dataset child (given its dataset doc) is effectively visible in
 * `layer` — its own override plus, inside a collection layer, the hidden-group
 * cascade.
 */
export function isDatasetChildVisible(
  layer: MapLayerDoc,
  dataset: DatasetSummary,
  overridesByLayer: MapLayerOverrideMap,
): boolean {
  return isChildEffectivelyVisible(
    layer,
    { childKey: datasetChildKey(dataset._id), dataset, kind: "dataset" },
    overridesByLayer,
  );
}

export function isChildEffectivelyVisible(
  layer: MapLayerDoc,
  child: LayerChild,
  overridesByLayer: globalThis.Map<string, globalThis.Map<string, boolean>>,
): boolean {
  if (!layer.visible) {
    return false;
  }
  const overrides = overridesByLayer.get(layer._id),
    ownVisible = (childKey: string) =>
      overrides === undefined ? true : (overrides.get(childKey) ?? true);
  if (!ownVisible(child.childKey)) {
    return false;
  }
  if (
    child.kind === "dataset" &&
    child.dataset.groupId !== undefined &&
    layer.targetType === "collection" &&
    !ownVisible(groupChildKey(child.dataset.groupId))
  ) {
    return false;
  }
  return true;
}

/**
 * The schema ids any layer currently renders: for each visible layer, its
 * expanded datasets minus per-dataset overrides, and — inside a collection
 * layer — datasets whose member group child is hidden. All layers'
 * contributions union, so a dataset visible in any layer renders once.
 */
export function resolveVisibleSchemaIds(
  layers: MapLayerDoc[],
  datasets: DatasetSummary[],
  expanded: Map<string, string[]>,
  overridesByLayer: globalThis.Map<string, globalThis.Map<string, boolean>>,
): Set<string> {
  const datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    visible = new Set<string>();
  for (const layer of layers) {
    if (!layer.visible) {
      continue;
    }
    const overrides = overridesByLayer.get(layer._id),
      ownVisible = (childKey: string) =>
        overrides === undefined ? true : (overrides.get(childKey) ?? true);
    for (const schemaId of expanded.get(layer._id) ?? []) {
      if (!ownVisible(datasetChildKey(schemaId))) {
        continue;
      }
      const dataset = datasetById.get(schemaId);
      if (
        dataset !== undefined &&
        dataset.groupId !== undefined &&
        layer.targetType === "collection" &&
        !ownVisible(groupChildKey(dataset.groupId))
      ) {
        continue;
      }
      visible.add(schemaId);
    }
  }
  return visible;
}

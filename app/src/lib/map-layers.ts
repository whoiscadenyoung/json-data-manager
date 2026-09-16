import type { FunctionReturnType } from "convex/server";

import { api } from "#convex/_generated/api";

export type MapLayerDoc = FunctionReturnType<typeof api.maps.listLayers>[number];
export type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];
export type GroupSummary = FunctionReturnType<typeof api.groups.list>[number];
export type MembershipRow = FunctionReturnType<
  typeof api.collections.listSchemaCollections
>[number];

export type LayerTargetType = "collection" | "group" | "dataset";

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

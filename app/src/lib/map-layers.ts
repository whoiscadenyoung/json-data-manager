import type { FunctionReturnType } from "convex/server";

import { api } from "#convex/_generated/api";

export type MapLayerDoc = FunctionReturnType<typeof api.maps.listLayers>[number];
export type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];
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
 * a collection layer via its `schemaCollections` memberships, a group layer
 * via member datasets' `groupId`, a dataset layer to itself. Membership
 * changes flow through on every read — nothing is denormalized. Standard
 * datasets never render geometry, so a target holding only standard datasets
 * expands to an empty list.
 */
export function expandLayerDatasets(
  layers: MapLayerDoc[],
  datasets: DatasetSummary[],
  memberships: MembershipRow[],
): Map<string, string[]> {
  const datasetById = new Map(datasets.map((dataset) => [dataset._id, dataset])),
    expanded = new Map<string, string[]>();
  for (const layer of layers) {
    const rawSchemaIds =
      layer.targetType === "collection"
        ? memberships
            .filter((membership) => membership.collectionId === layer.targetId)
            .map((membership) => membership.schemaId)
        : layer.targetType === "group"
          ? datasets
              .filter((dataset) => dataset.groupId === layer.targetId)
              .map((dataset) => dataset._id)
          : [layer.targetId];
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

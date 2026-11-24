import type { Geometry } from "@caden/json-cms/react";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";

/**
 * One dataset as the map pipeline reads it — the shape the Postgres store's
 * summary rows are lifted into by `pgSummaryToDatasetSummary`.
 */
export interface DatasetSummary {
  _id: string;
  boundingBox?: number[];
  createdBy?: string;
  description?: string;
  editPolicy?: string;
  entryCount?: number;
  featureCount?: number;
  fieldCount?: number;
  geometryType?:
    | "Point"
    | "LineString"
    | "Polygon"
    | "MultiPoint"
    | "MultiLineString"
    | "MultiPolygon";
  groupId?: string;
  kind: "geospatial" | "standard";
  lifecycle?: string;
  mapTileArchiveBuiltVersion?: number;
  mapTileArchiveBytes?: number;
  mapTileArchiveMaxZoom?: number;
  mapTileCacheVersion?: number;
  publishedVisibility?: "author" | "everyone";
  title: string;
}

/**
 * A geometry row re-keyed for a chain layer (7b, #103): the resolved frozen
 * row's geometry drawn under the anchor dataset's id — `sourceSchemaId`
 * preserves where the entry actually lives, which is what the click payload
 * carries.
 */
export type KeyedGeometryEntry = DatasetGeometryRow & { sourceSchemaId?: string };

/**
 * Re-keys rows for a 7b chain layer (#103): a published map's dataset layer
 * resolves its (draft) target through the target's version chain and renders
 * the RESOLVED row's data under the anchor's own render id — the anchor's
 * live rows never draw (the layer draws its published head, not the draft's
 * edits), while copies of the resolved rows draw under the anchor id with
 * `sourceSchemaId` pointing at the frozen row so the click payload lands on
 * the published dataset's page. Copies are never re-keyed again (one pass
 * over the fetched rows). Built in a loop, not a map callback (the
 * map-spread rule).
 */
export function keyedGeometryRows(
  geometries: readonly DatasetGeometryRow[],
  chainSourceByRenderId: ReadonlyMap<string, string> = new globalThis.Map(),
): KeyedGeometryEntry[] {
  const chainRendersBySource = new globalThis.Map<string, string[]>();
  for (const [renderId, sourceId] of chainSourceByRenderId) {
    const existing = chainRendersBySource.get(sourceId);
    if (existing === undefined) {
      chainRendersBySource.set(sourceId, [renderId]);
    } else {
      existing.push(renderId);
    }
  }
  const keyed: KeyedGeometryEntry[] = [];
  for (const row of geometries) {
    const chainRenderIds = chainRendersBySource.get(row.schemaId);
    if (chainRenderIds !== undefined) {
      for (const renderId of chainRenderIds) {
        const copy: KeyedGeometryEntry = { ...row, schemaId: renderId };
        copy.sourceSchemaId = row.schemaId;
        keyed.push(copy);
      }
    }
    // A chain-resolved anchor's own live rows draw nothing — the layer
    // renders its published head through the copies above.
    if (!chainSourceByRenderId.has(row.schemaId)) {
      keyed.push(row);
    }
  }
  return keyed;
}

/**
 * Builds a map-renderable feature row given its already-resolved `Geometry`.
 * A chain layer's feature still points at the entry's real home (the
 * published dataset) so the popup and its "View details" link keep working —
 * the `{entryId, schemaId}` payload shape is 3b's contract (issue #96).
 */
export function toFeatureRow(geometry: KeyedGeometryEntry, resolved: Geometry) {
  return {
    id: geometry.entryId,
    geometry: resolved,
    properties: {
      entryId: geometry.entryId,
      schemaId: geometry.sourceSchemaId ?? geometry.schemaId,
    },
  };
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

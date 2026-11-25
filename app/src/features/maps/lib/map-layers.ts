import type { Geometry } from "@caden/json-cms/react";

import type { ResolvedGeometryRow } from "#/lib/dataset-rows";
import type { DatasetBoundingBox } from "#/lib/store/datasets";
import type { GeometryRow } from "#/lib/store/geometries";

/**
 * The stored extent (the PostGIS envelope as a GeoJSON Polygon) as the flat
 * [minLon, minLat, maxLon, maxLat] tuple the map fit needs, or absent — no
 * stored extent yet, or a degenerate ring.
 */
export function extentBounds(bbox: DatasetBoundingBox | null): number[] | undefined {
  if (bbox === null || bbox.type !== "Polygon") {
    return undefined;
  }
  const ring = bbox.coordinates[0];
  if (ring === undefined) {
    return undefined;
  }
  let minLon = Number.POSITIVE_INFINITY,
    minLat = Number.POSITIVE_INFINITY,
    maxLon = Number.NEGATIVE_INFINITY,
    maxLat = Number.NEGATIVE_INFINITY,
    any = false;
  for (const point of ring) {
    const lon = point[0],
      lat = point[1];
    if (typeof lon !== "number" || typeof lat !== "number") {
      return undefined;
    }
    any = true;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return any ? [minLon, minLat, maxLon, maxLat] : undefined;
}

/**
 * A geometry row re-keyed for a chain layer (7b, #103): the resolved frozen
 * row's geometry drawn under the anchor dataset's id — `sourceDatasetId`
 * preserves where the entry actually lives, which is what the click payload
 * carries.
 */
export type KeyedGeometryEntry = ResolvedGeometryRow & { sourceDatasetId?: string };

/**
 * Re-keys rows for a 7b chain layer (#103): a published map's dataset layer
 * resolves its (draft) target through the target's version chain and renders
 * the RESOLVED row's data under the anchor's own render id — the anchor's
 * live rows never draw (the layer draws its published head, not the draft's
 * edits), while copies of the resolved rows draw under the anchor id with
 * `sourceDatasetId` pointing at the frozen row so the click payload lands on
 * the published dataset's page. Copies are never re-keyed again (one pass
 * over the fetched rows). Built in a loop, not a map callback (the
 * map-spread rule).
 */
export function keyedGeometryRows(
  geometries: readonly GeometryRow[],
  chainSourceByDatasetId: ReadonlyMap<string, string> = new globalThis.Map(),
): KeyedGeometryEntry[] {
  const chainRendersBySource = new globalThis.Map<string, string[]>();
  for (const [renderId, sourceId] of chainSourceByDatasetId) {
    const existing = chainRendersBySource.get(sourceId);
    if (existing === undefined) {
      chainRendersBySource.set(sourceId, [renderId]);
    } else {
      existing.push(renderId);
    }
  }
  const keyed: KeyedGeometryEntry[] = [];
  for (const row of geometries) {
    const chainRenderIds = chainRendersBySource.get(row.datasetId);
    if (chainRenderIds !== undefined) {
      for (const renderId of chainRenderIds) {
        const copy: KeyedGeometryEntry = { ...row, datasetId: renderId };
        copy.sourceDatasetId = row.datasetId;
        keyed.push(copy);
      }
    }
    // A chain-resolved anchor's own live rows draw nothing — the layer
    // renders its published head through the copies above.
    if (!chainSourceByDatasetId.has(row.datasetId)) {
      keyed.push(row);
    }
  }
  return keyed;
}

/**
 * Builds a map-renderable feature row given its already-resolved `Geometry`.
 * A chain layer's feature still points at the entry's real home (the
 * published dataset) so the popup and its "View details" link keep working —
 * the `{entryId, datasetId}` payload shape is 3b's contract (issue #96).
 */
export function toFeatureRow(geometry: KeyedGeometryEntry, resolved: Geometry) {
  return {
    id: geometry.entryId,
    geometry: resolved,
    properties: {
      entryId: geometry.entryId,
      datasetId: geometry.sourceDatasetId ?? geometry.datasetId,
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

/**
 * The row's resolved geometry: the worker's structured-cloned payload
 * (`geometryResolved`, ADR 0025) or the verbatim inline jsonb (`geometry`).
 * `undefined` when neither — that row's payload failed to resolve, and it
 * draws nowhere (the seam's per-row catch posture).
 *
 * This is the ONE `Geometry` narrowing at the map boundary: the store's
 * `DatasetGeometryType` union allows `GeometryCollection`; the app never
 * writes one (the store's note), and the pipeline's `Geometry`-typed readers
 * would drop it otherwise.
 */
export function resolvedGeometryOf(row: ResolvedGeometryRow): Geometry | undefined {
  const geometry = row.geometryResolved ?? row.geometry;
  if (geometry === null || geometry === undefined) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the comment above; the narrowing posture every adapter stated before this collapse.
  return geometry as Geometry;
}

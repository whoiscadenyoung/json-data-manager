import { computeBbox } from "./geometry.js";
import type { BoundingBox } from "./geometry.js";
import type { Feature, FeatureCollection, Geometry } from "./types.js";

export interface FeatureRow<P> {
  id?: string;
  geometry: Geometry | null;
  properties: P;
  bbox?: BoundingBox;
}

/** Assembles a GeoJSON `Feature` from a row-shaped input. `id`/`bbox` are omitted entirely (not set to undefined) when absent. */
export function buildFeature<P>(row: FeatureRow<P>): Feature<P> {
  const feature = {
    type: "Feature" as const,
    ...(row.id !== undefined ? { id: row.id } : {}),
    geometry: row.geometry,
    properties: row.properties,
    ...(row.bbox !== undefined ? { bbox: row.bbox } : {}),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built incrementally via conditional spreads, which the strict Feature<P> interface can't verify structurally.
  return feature as Feature<P>;
}

/**
 * Assembles a GeoJSON `FeatureCollection` by joining multiple row-shaped inputs.
 * @param options.bbox Overall bounding box. When omitted, computed via `computeBbox` over the assembled features, and omitted entirely when there are no determinable coordinates.
 */
export function buildFeatureCollection<P>(
  rows: FeatureRow<P>[],
  options?: { bbox?: BoundingBox },
): FeatureCollection<P> {
  const features = rows.map((row) => buildFeature(row)),
    // computeBbox only reads `features[].geometry`; the generic `P` properties type
    // param can't be verified against the default here, so this cast is safe but unchecked.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    collectionForBbox = { type: "FeatureCollection", features } as unknown as FeatureCollection,
    resolvedBbox =
      options !== undefined && options.bbox !== undefined
        ? options.bbox
        : computeBbox(collectionForBbox);
  return {
    type: "FeatureCollection",
    features,
    ...(resolvedBbox !== undefined ? { bbox: resolvedBbox } : {}),
  };
}

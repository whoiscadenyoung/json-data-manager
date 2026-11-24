import type { GeometryType } from "@caden/json-cms/react";

/**
 * The row shapes the map and table surfaces share. The Postgres stores'
 * rows (`#/lib/store/entries`, `#/lib/store/geometries`) are lifted into
 * these by the adapters in `features/maps/components/pg-layer-rows.ts`; the
 * reads themselves live in `dataset-rows-pg.ts`.
 */

/**
 * One entry row: its id, owning dataset and field data. `_creationTime` is
 * epoch milliseconds, `0` when the source carries none (live view rows).
 */
export interface DatasetEntryRow {
  _creationTime: number;
  _id: string;
  data: unknown;
  geometryType?: GeometryType;
  schemaId: string;
}

/** One geometry row: the entry it belongs to, with its geometry inline (`geometryJson`) or at a storage URL. */
export interface DatasetGeometryRow {
  _creationTime: number;
  _id: string;
  bbox?: number[] | null;
  entryId: string;
  geometryJson?: string;
  geometryUrl?: string;
  schemaId: string;
  type: GeometryType;
}

/**
 * The map's feature-click payload as the popup's selection shape — kept
 * structural so any surface that clicks a feature can hand the pair
 * straight in.
 */
export interface FeatureSelection {
  entryId: string;
  schemaId: string;
}

/** `row.data` as a generic record — `{}` when the entry carries no object. */
export function entryDataRecord(row: DatasetEntryRow): Record<string, unknown> {
  return isRecordShaped(row.data) ? row.data : {};
}

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

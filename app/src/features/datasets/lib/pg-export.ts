import type { Geometry } from "@caden/data-core/geojson";

import {
  fetchDatasetEntryRows,
  resolveDatasetGeometryRows,
  type DatasetEntryRow,
} from "#/lib/dataset-rows-pg";
import type { StoreOptions } from "#/lib/store/client";

import type { ExportableEntry } from "./export";

/**
 * The Postgres edition of the export flows' data half (stage 5, #204): the
 * dataset and group export dialogs' row reads, geometry resolution, and
 * dialogs' row reads and geometry resolution over the PG row-resolution seam,
 * feeding the SAME builders (`buildGeoJsonCollection` / `buildJsonPayload` /
 * `entryRows` / `exportExcelWorkbook`). Joined fields retired with the derived
 * registry (#301); a view exports as an ordinary dataset.
 *
 * Completeness rides the seam: `fetchDatasetEntryRows` pages
 * `entries.listPage` to exhaustion (`nextCursor === null` is done — design
 * §5 intro), so an export always writes the WHOLE dataset without a
 * standing subscription. Oversized geometry payloads (the storage-backed
 * rows, §6) resolve through `resolveDatasetGeometryRows`' short-lived
 * signed URLs; a failed row leaves its geometry unresolved instead of
 * failing the export.
 *
 * PG rows carry no `geometryId` — geometry rows are 1:1 with entries
 * (keyed by `entryId`, the shape `dataset_rows_for_tiles` hands back), so
 * the exported entry's geometry key IS its entry id and
 * `pgExportGeometries`' map is keyed to match.
 */

/** One PG entry row as the exporters' minimal entry shape — the geometry key is the entry id (see the module doc). */
export function pgExportEntryOf(row: DatasetEntryRow): ExportableEntry {
  return {
    _id: row.id,
    data: row.data,
    geometryId: row.geometryType === null ? undefined : row.id,
  };
}

/** The dataset's full entry set, materialized through the seam (specs applied inside it) and adapted for the export builders. */
export async function pgExportEntries(
  datasetId: string,
  options?: StoreOptions,
): Promise<ExportableEntry[]> {
  const rows = await fetchDatasetEntryRows(datasetId, options);
  return rows.map(pgExportEntryOf);
}

/** The dataset's geometry rows resolved to `Geometry` values, keyed by ENTRY id (the PG geometry-row identity — 1:1 with entries). Inline jsonb resolves synchronously; storage-backed payloads fetch through signed URLs, in parallel. */
export async function pgExportGeometries(
  datasetId: string,
  options?: StoreOptions,
): Promise<globalThis.Map<string, Geometry>> {
  const resolved = await resolveDatasetGeometryRows(datasetId, options);
  return new globalThis.Map(resolved);
}

import type { Geometry } from "@caden/data-core/geojson";

import { fetchDatasetEntryRows, resolveDatasetGeometryRows } from "#/lib/dataset-rows";
import type { StoreOptions } from "#/lib/store/client";
import type { EntryRow } from "#/lib/store/entries";

/**
 * Client-side export helpers shared by the dataset and group export
 * dialogs: GeoJSON / JSON payloads and Excel workbooks (via exceljs, the
 * same writer the xlsx import parser uses for reading), plus the data half
 * that materializes a dataset's rows through the row-resolution seam
 * (stage 5, #204). The "include joined fields" step retired with the
 * derived registry (#301): a view is a real dataset, so its joined fields
 * export as ordinary columns.
 *
 * Completeness rides the seam: `fetchDatasetEntryRows` pages
 * `entries.listPage` to exhaustion (`nextCursor === null` is done — design
 * §5 intro), so an export always writes the WHOLE dataset without a
 * standing subscription. Oversized geometry payloads (the storage-backed
 * rows, §6) resolve through `resolveDatasetGeometryRows`' short-lived
 * signed URLs; a failed row leaves its geometry unresolved instead of
 * failing the export.
 *
 * Store rows carry no `geometryId` — geometry rows are 1:1 with entries
 * (keyed by `entryId`, the shape `dataset_rows_for_tiles` hands back), so
 * the exported entry's geometry key IS its entry id and
 * `exportDatasetGeometries`' map is keyed to match.
 */

/** Minimal entry shape the exporters need. */
export interface ExportableEntry {
  _id: string;
  data: unknown;
  geometryId?: string;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(content: string, filename: string, type = "application/json"): void {
  downloadBlob(new Blob([content], { type }), filename);
}

/**
 * A GeoJSON FeatureCollection of `entries`: each entry's schema `data`
 * becomes the feature properties, and its geometry (when the entry has one)
 * rides along — entries without geometry export with `"geometry": null` so
 * row counts stay consistent with the other formats.
 *
 * `resolvedByGeometryRowId` is `exportDatasetGeometries`' map, keyed by entry
 * id — which is exactly what `entry.geometryId` points at.
 */
export function buildGeoJsonCollection(
  entries: ExportableEntry[],
  resolvedByGeometryRowId: globalThis.Map<string, Geometry>,
  datasetId: string,
): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    // Identifies which dataset's schema the properties conform to — useful
    // when a group export writes several collections side by side.
    id: datasetId,
    features: entries.map((entry) => ({
      type: "Feature",
      geometry: entry.geometryId ? (resolvedByGeometryRowId.get(entry.geometryId) ?? null) : null,
      properties: entry.data,
    })),
  };
}

/** The plain-JSON export payload — the same shape the existing export button produced. */
export function buildJsonPayload(
  schema: unknown,
  entries: ExportableEntry[],
): Record<string, unknown> {
  return {
    $schema: schema,
    entries: entries.map((entry) => entry.data),
  };
}

/** Objects/arrays can't sit in a cell — serialize them; nulls become empty. */
function cellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to primitives above (nullish and objects return early); cell values are strings or numbers by construction.
  return value as string | number;
}

/**
 * Excel sheet names: max 31 chars, no [:\\/?*[]], unique within a workbook.
 * Uniqueness loops and folds case (#133 item 14): the old single,
 * case-sensitive dedupe turned "A", "A-3", "A" into TWO "A-3" sheets (the
 * second suffix landed on an already-taken name), and "a" against "A"
 * collided outright — Excel reads sheet names case-insensitively.
 */
export function sanitizeSheetName(title: string, used: Set<string>): string {
  const base =
    title
      .replace(/[:\\/?*[\]]/g, " ")
      .trim()
      .slice(0, 31) || "Sheet";
  let name = base;
  for (let counter = used.size + 1; containsFolded(used, name); counter += 1) {
    const suffix = `-${counter}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

/** True when any already-used sheet name equals `name` case-insensitively. */
function containsFolded(used: ReadonlySet<string>, name: string): boolean {
  const folded = name.toLowerCase();
  for (const entry of used) {
    if (entry.toLowerCase() === folded) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes entries into flat rows for an Excel worksheet: object data
 * spreads as-is (one column per property); a non-object entry degrades to a
 * single `value` column.
 */
export function entryRows(entries: ExportableEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) =>
    typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the typeof/Array guards above exclude null and arrays; entry data is a plain JSON object by construction.
        (entry.data as Record<string, unknown>)
      : { value: entry.data },
  );
}

/**
 * Writes one Excel workbook and triggers its download. `sheets` maps
 * 1:1 to worksheets; columns are the union of each sheet's row keys in
 * first-seen order.
 */
export async function exportExcelWorkbook(
  sheets: { name: string; rows: Array<Record<string, unknown>> }[],
  filename: string,
): Promise<void> {
  const ExcelJS = await import("exceljs"),
    workbook = new ExcelJS.Workbook(),
    used = new Set<string>();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name, used)),
      columns: string[] = [];
    for (const row of sheet.rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }
    worksheet.columns = columns.map((column) => ({ header: column, key: column }));
    worksheet.addRows(
      sheet.rows.map((row) => Object.fromEntries(columns.map((c) => [c, cellValue(row[c])]))),
    );
  }
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}

/** One store entry row as the exporters' minimal entry shape — the geometry key is the entry id (see the module doc). */
export function exportEntryOf(row: EntryRow): ExportableEntry {
  return {
    _id: row.id,
    data: row.data,
    geometryId: row.geometryType === null ? undefined : row.id,
  };
}

/** The dataset's full entry set, materialized through the seam (specs applied inside it) and adapted for the export builders. */
export async function exportDatasetEntries(
  datasetId: string,
  options?: StoreOptions,
): Promise<ExportableEntry[]> {
  const rows = await fetchDatasetEntryRows(datasetId, options);
  return rows.map(exportEntryOf);
}

/** The dataset's geometry rows resolved to `Geometry` values, keyed by ENTRY id (1:1 with entries). Inline jsonb resolves synchronously; storage-backed payloads fetch through signed URLs, in parallel. */
export async function exportDatasetGeometries(
  datasetId: string,
  options?: StoreOptions,
): Promise<globalThis.Map<string, Geometry>> {
  const resolved = await resolveDatasetGeometryRows(datasetId, options);
  return new globalThis.Map(resolved);
}

import type { Geometry } from "@caden/json-cms/react";

/**
 * Client-side export helpers shared by the dataset and group export
 * dialogs: GeoJSON / JSON payloads and Excel workbooks (via exceljs, the
 * same writer the xlsx import parser uses for reading).
 */

/** Minimal entry shape the exporters need (Convex rows satisfy this). */
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
 * `resolvedByGeometryRowId` is `useResolvedGeometries`' output, keyed by the
 * geometry row id — which is exactly what `entry.geometryId` points at.
 */
export function buildGeoJsonCollection(
  entries: ExportableEntry[],
  resolvedByGeometryRowId: globalThis.Map<string, Geometry>,
  schemaId: string,
): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    // Identifies which dataset's schema the properties conform to — useful
    // when a group export writes several collections side by side.
    id: schemaId,
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
  return value as string | number;
}

/** Excel sheet names: max 31 chars, no [:\\/?*[]], unique within a workbook. */
export function sanitizeSheetName(title: string, used: Set<string>): string {
  const base =
      title
        .replace(/[:\\/?*[\]]/g, " ")
        .trim()
        .slice(0, 31) || "Sheet",
    dedupe = (name: string) =>
      used.has(name) ? `${name.slice(0, 31 - 2)}-${used.size + 1}` : name,
    name = dedupe(base);
  used.add(name);
  return name;
}

/**
 * Normalizes entries into flat rows for an Excel worksheet: object data
 * spreads as-is (one column per property); a non-object entry degrades to a
 * single `value` column.
 */
export function entryRows(entries: ExportableEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) =>
    typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
      ? (entry.data as Record<string, unknown>)
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

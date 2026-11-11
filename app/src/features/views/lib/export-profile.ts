import type { OutputSchema } from "@caden/data-core/views";

/**
 * Export profiles (issue #303; docs/views-design.md §9): how a view's SAVED
 * rows are written out. Pure serializers only: the caller reads the snapshot
 * rows (entries) and geometries.
 */

export type ExportProfileFormat = "geojson" | "csv" | "json";

export interface ExportSettings {
  format: ExportProfileFormat;
  /** Property names: the output keys, or the labels (falling back to the key). */
  propertyNames: "keys" | "labels";
  /** `omit` drops empty values (null, undefined, empty string) instead of writing nulls. */
  emptyFields: "keep" | "omit";
  /** Decimal places kept in coordinates; `null` keeps them all. */
  precision: number | null;
}

export interface ExportRow {
  data: Record<string, unknown>;
  geometry: { type: string; coordinates?: unknown; geometries?: unknown } | null;
}

export interface ExportColumn {
  /** The key in the saved row. */
  key: string;
  /** The property name written out. */
  name: string;
}

export const MAX_PRECISION = 15;

/** New profiles start from the view's own empty-field choice. */
export function defaultSettings(output: OutputSchema | undefined): ExportSettings {
  return {
    format: "geojson",
    propertyNames: "keys",
    emptyFields: output === undefined ? "keep" : output.emptyFields,
    precision: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read stored settings, filling anything missing or invalid from the defaults. */
export function parseSettings(raw: unknown, output: OutputSchema | undefined): ExportSettings {
  const base = defaultSettings(output);
  if (!isRecord(raw)) {
    return base;
  }
  const format = raw["format"],
    names = raw["propertyNames"],
    empty = raw["emptyFields"],
    precision = raw["precision"];
  return {
    format: format === "geojson" || format === "csv" || format === "json" ? format : base.format,
    propertyNames: names === "keys" || names === "labels" ? names : base.propertyNames,
    emptyFields: empty === "keep" || empty === "omit" ? empty : base.emptyFields,
    precision:
      typeof precision === "number" &&
      Number.isInteger(precision) &&
      precision >= 0 &&
      precision <= MAX_PRECISION
        ? precision
        : null,
  };
}

/**
 * The exported columns: the output's non-hidden fields in order. An empty
 * output list means "every field", so the columns come from the rows' keys
 * (first-seen order) and have no labels.
 */
export function exportColumns(
  output: OutputSchema,
  rows: readonly ExportRow[],
  propertyNames: ExportSettings["propertyNames"],
): ExportColumn[] {
  const wanted =
    output.fields.length > 0
      ? output.fields
          .filter((field) => field.hidden !== true)
          .map((field) => ({
            key: field.key,
            preferred:
              propertyNames === "labels" && field.label !== undefined && field.label !== ""
                ? field.label
                : field.key,
          }))
      : [...new Set(rows.flatMap((row) => Object.keys(row.data)))].map((key) => ({
          key,
          preferred: key,
        }));
  // Two columns must never share a property name: fall back to the key.
  const used = new Set<string>();
  return wanted.map((item) => {
    let name = item.preferred;
    if (used.has(name)) {
      name = item.key;
    }
    let n = 2;
    while (used.has(name)) {
      name = `${item.key}_${n}`;
      n += 1;
    }
    used.add(name);
    return { key: item.key, name };
  });
}

export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function propertiesOf(
  row: ExportRow,
  columns: readonly ExportColumn[],
  emptyFields: ExportSettings["emptyFields"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row.data[column.key];
    if (isEmptyValue(value)) {
      if (emptyFields === "keep") {
        out[column.name] = null;
      }
    } else {
      out[column.name] = value;
    }
  }
  return out;
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** Round every number in a coordinate tree. */
export function roundCoordinates(coordinates: unknown, precision: number): unknown {
  if (typeof coordinates === "number") {
    return roundTo(coordinates, precision);
  }
  if (Array.isArray(coordinates)) {
    return coordinates.map((item: unknown) => roundCoordinates(item, precision));
  }
  return coordinates;
}

function geometryOf(
  geometry: ExportRow["geometry"],
  precision: number | null,
): Record<string, unknown> | null {
  if (geometry === null) {
    return null;
  }
  if (precision === null) {
    return { ...geometry };
  }
  const out: Record<string, unknown> = { ...geometry };
  if (geometry.coordinates !== undefined) {
    out["coordinates"] = roundCoordinates(geometry.coordinates, precision);
  }
  if (Array.isArray(geometry.geometries)) {
    out["geometries"] = geometry.geometries.map((child: unknown) =>
      isRecord(child) && typeof child["type"] === "string"
        ? geometryOf({ ...child, type: child["type"] }, precision)
        : child,
    );
  }
  return out;
}

export function buildFeatureCollection(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  settings: ExportSettings,
): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      geometry: geometryOf(row.geometry, settings.precision),
      properties: propertiesOf(row, columns, settings.emptyFields),
    })),
  };
}

export function buildJsonRows(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  settings: ExportSettings,
): Record<string, unknown>[] {
  return rows.map((row) => propertiesOf(row, columns, settings.emptyFields));
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV is rectangular: "omit" drops a column only when it is empty in every row. */
export function buildCsv(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  settings: ExportSettings,
): string {
  const shown =
    settings.emptyFields === "omit"
      ? columns.filter((column) => rows.some((row) => !isEmptyValue(row.data[column.key])))
      : columns;
  const lines = [shown.map((column) => csvCell(column.name)).join(",")];
  for (const row of rows) {
    lines.push(shown.map((column) => csvCell(row.data[column.key])).join(","));
  }
  return lines.join("\n");
}

/** The file text, extension and MIME type for the profile's format. */
export function serializeExport(
  rows: readonly ExportRow[],
  output: OutputSchema,
  settings: ExportSettings,
): { text: string; extension: string; mime: string } {
  const columns = exportColumns(output, rows, settings.propertyNames);
  switch (settings.format) {
    case "csv": {
      return { text: buildCsv(rows, columns, settings), extension: "csv", mime: "text/csv" };
    }
    case "json": {
      return {
        text: JSON.stringify(buildJsonRows(rows, columns, settings), null, 2),
        extension: "json",
        mime: "application/json",
      };
    }
    default: {
      return {
        text: JSON.stringify(buildFeatureCollection(rows, columns, settings), null, 2),
        extension: "geojson",
        mime: "application/geo+json",
      };
    }
  }
}

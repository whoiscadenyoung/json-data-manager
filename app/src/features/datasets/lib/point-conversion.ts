/**
 * Spreadsheet → points (issue #293): the pure plan the conversion card
 * previews before anything is written. Coordinates follow the one shared
 * policy in `@caden/data-core/coordinate-columns` (WGS84 lon/lat, decimal
 * text or numbers, out-of-range values rejected), the same one the import
 * flow uses — so "will convert" here is exactly what gets written.
 */
import {
  extractPointGeometry,
  isValidLatitude,
  isValidLongitude,
  parseCoordinateValue,
} from "@caden/data-core/coordinate-columns";
import type { Point } from "@caden/data-core/geojson";

export interface PointPlanRow {
  id: string;
  data: unknown;
}

export interface PointPlan {
  points: Array<{ id: string; geometry: Point }>;
  /** Rows where either coordinate is absent or blank — they stay plain entries. */
  missing: number;
  /** Rows where a coordinate isn't a number. */
  notNumbers: number;
  /** Rows with numbers outside -90..90 latitude / -180..180 longitude. */
  outOfRange: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

type RowOutcome = "point" | "missing" | "notNumbers" | "outOfRange";

function classify(data: Record<string, unknown>, latField: string, lonField: string): RowOutcome {
  if (isBlank(data[latField]) || isBlank(data[lonField])) {
    return "missing";
  }
  const lat = parseCoordinateValue(data[latField]),
    lon = parseCoordinateValue(data[lonField]);
  if (lat === undefined || lon === undefined) {
    return "notNumbers";
  }
  return isValidLatitude(lat) && isValidLongitude(lon) ? "point" : "outOfRange";
}

/** What converting `rows` with this lat/lon pair would write. Pure. */
export function planPointConversion(
  rows: readonly PointPlanRow[],
  latField: string,
  lonField: string,
): PointPlan {
  const plan: PointPlan = { missing: 0, notNumbers: 0, outOfRange: 0, points: [] };
  for (const row of rows) {
    const data = isRecord(row.data) ? row.data : {},
      outcome = classify(data, latField, lonField);
    if (outcome !== "point") {
      plan[outcome] += 1;
      continue;
    }
    const geometry = extractPointGeometry(data, latField, lonField);
    if (geometry !== undefined) {
      plan.points.push({ geometry, id: row.id });
    }
  }
  return plan;
}

/** "3 rows have no coordinates, 1 isn't a number" — the rows that stay plain entries, or "" when none. */
export function skippedSummary(plan: PointPlan): string {
  const parts: string[] = [];
  if (plan.missing > 0) {
    parts.push(
      `${plan.missing.toLocaleString()} ${plan.missing === 1 ? "has" : "have"} no coordinates`,
    );
  }
  if (plan.notNumbers > 0) {
    parts.push(
      `${plan.notNumbers.toLocaleString()} ${plan.notNumbers === 1 ? "isn't a number" : "aren't numbers"}`,
    );
  }
  if (plan.outOfRange > 0) {
    parts.push(
      `${plan.outOfRange.toLocaleString()} ${plan.outOfRange === 1 ? "is" : "are"} out of range`,
    );
  }
  return parts.join(", ");
}

/** Column names across the rows, in first-seen order. */
export function columnsOfRows(rows: readonly PointPlanRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (isRecord(row.data)) {
      for (const key of Object.keys(row.data)) {
        seen.add(key);
      }
    }
  }
  return [...seen];
}

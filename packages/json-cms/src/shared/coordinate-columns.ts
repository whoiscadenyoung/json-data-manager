/**
 * Detects latitude/longitude columns in plain tabular row data (CSV/JSON/
 * Excel imports, or an already-imported "standard" dataset's entries) and
 * builds a `Point` geometry from a row's coordinate pair. Shared between the
 * `react` package (import-time detection UI) and the `component` (the
 * server-side geospatial-conversion workflow), so both sides agree on what
 * counts as a valid coordinate.
 */
import type { Point } from "./geojson/types.js";

const LAT_WORDS = ["latitude", "lat"],
  LON_WORDS = ["longitude", "lng", "lon", "long"],
  GENERIC_LAT_WORDS = ["y"],
  GENERIC_LON_WORDS = ["x"];

export interface CoordinateColumnGuess {
  latField: string;
  lonField: string;
  /**
   * "high" for a named match ("latitude"/"lat"/"longitude"/"lon"/"lng"/
   * "long"); "low" for the generic "x"/"y" fallback, which is far more
   * likely to be a false positive on an unrelated numeric column.
   */
  confidence: "high" | "low";
}

/** Parses a coordinate cell (already-numeric, or a numeric string) to a finite number, or `undefined` if it isn't one. */
export function parseCoordinateValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function isValidLatitude(value: number): boolean {
  return value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return value >= -180 && value <= 180;
}

/** Builds a `Point` geometry from `data[latField]`/`data[lonField]`, or `undefined` if either is missing, non-numeric, or out of range. */
export function extractPointGeometry(
  data: unknown,
  latField: string,
  lonField: string,
): Point | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the `typeof === "object"` check above.
  const record = data as Record<string, unknown>,
    lat = parseCoordinateValue(record[latField]),
    lon = parseCoordinateValue(record[lonField]);
  if (lat === undefined || lon === undefined || !isValidLatitude(lat) || !isValidLongitude(lon)) {
    return undefined;
  }
  return { coordinates: [lon, lat], type: "Point" };
}

/** Lowercased, non-alphanumeric-delimited tokens of a column name — `"Facility_Latitude"` → `["facility", "latitude"]`. */
function normalizedTokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** 0 when `name` normalizes to exactly one of `words`, 1 when one of its several tokens does, -1 for no match. */
function rankColumn(name: string, words: string[]): number {
  const tokens = normalizedTokens(name);
  if (tokens.length === 1 && words.includes(tokens[0])) {
    return 0;
  }
  return tokens.some((token) => words.includes(token)) ? 1 : -1;
}

/**
 * Evenly-spaced subset of `items`, at most `sampleSize` long — e.g. every
 * 10th row rather than just the first N. A coordinate column is often only
 * "available" on some rows (a geocoding backfill that didn't reach every
 * one, or several years' worth of differently-sourced batches), so a plain
 * prefix slice risks landing entirely on the rows that never got one; an
 * even spread across the whole dataset is far more likely to include at
 * least a few populated rows either way.
 */
function sampleEvenly<T>(items: T[], sampleSize: number): T[] {
  if (items.length <= sampleSize) {
    return items;
  }
  const step = items.length / sampleSize,
    sample: T[] = [];
  for (let i = 0; i < sampleSize; i += 1) {
    sample.push(items[Math.floor(i * step)]);
  }
  return sample;
}

/** Column names appearing anywhere across `rows`, in first-seen order. */
function collectColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return [...seen];
}

/** True when at least `minRatio` of the rows that have either field present parse as valid, in-range coordinates. */
function validatePair(
  rows: Array<Record<string, unknown>>,
  latField: string,
  lonField: string,
  minRatio: number,
): boolean {
  let present = 0,
    valid = 0;
  for (const row of rows) {
    if (!(latField in row) && !(lonField in row)) {
      continue;
    }
    present += 1;
    const lat = parseCoordinateValue(row[latField]),
      lon = parseCoordinateValue(row[lonField]);
    if (lat !== undefined && lon !== undefined && isValidLatitude(lat) && isValidLongitude(lon)) {
      valid += 1;
    }
  }
  return present > 0 && valid / present >= minRatio;
}

/** The best-ranked, data-validated lat/lon column pair for `words`, or `undefined` if none validate. */
function bestValidPair(
  columns: string[],
  sample: Array<Record<string, unknown>>,
  latWords: string[],
  lonWords: string[],
): { latField: string; lonField: string } | undefined {
  const rank = (words: string[]) =>
      columns
        .map((name) => ({ name, score: rankColumn(name, words) }))
        .filter((c) => c.score >= 0)
        // oxlint-disable-next-line unicorn/no-array-sort -- `.toSorted()` needs ES2023 lib; this repo targets ES2021, and the array is already a fresh one from `.map()`/`.filter()`, so mutating it in place is harmless.
        .sort((a, b) => a.score - b.score),
    latCandidates = rank(latWords),
    lonCandidates = rank(lonWords);
  for (const lat of latCandidates) {
    for (const lon of lonCandidates) {
      if (lat.name !== lon.name && validatePair(sample, lat.name, lon.name, 0.7)) {
        return { latField: lat.name, lonField: lon.name };
      }
    }
  }
  return undefined;
}

/**
 * Guesses which two columns of tabular row data hold a point's latitude and
 * longitude: first by naming convention ("Latitude"/"Longitude",
 * "lat"/"lon"/"lng"/"long"), falling back to the more generic "x"/"y" only
 * if no named pair validates — each candidate pair is checked against a
 * sample of the actual values (in-range numbers) before being accepted, so
 * an unrelated numeric column doesn't get mistaken for coordinates. Returns
 * `undefined` when nothing validates confidently enough; the caller should
 * let the user pick columns manually in that case.
 */
export function detectCoordinateColumns(
  rows: Array<Record<string, unknown>>,
  sampleSize = 50,
): CoordinateColumnGuess | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const sample = sampleEvenly(rows, sampleSize),
    columns = collectColumns(sample),
    named = bestValidPair(columns, sample, LAT_WORDS, LON_WORDS);
  if (named) {
    return { ...named, confidence: "high" };
  }
  const generic = bestValidPair(columns, sample, GENERIC_LAT_WORDS, GENERIC_LON_WORDS);
  return generic ? { ...generic, confidence: "low" } : undefined;
}

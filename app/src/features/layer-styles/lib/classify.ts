/**
 * Class generation for the simple editor: distinct values for a categories
 * style, and equal-interval / quantile breaks for a graduated style. Pure —
 * fed the field values the editor already loaded for the dataset.
 */

export type CategoryValue = string | number | boolean;

export interface DistinctValue {
  value: CategoryValue;
  count: number;
}

function isCategoryValue(value: unknown): value is CategoryValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * A field's distinct scalar values, most frequent first (ties in value
 * order). Values are keyed by their string form because that is how the
 * compiled `match` compares them (`to-string`), so `3` and `"3"` are one class.
 */
export function distinctValues(values: readonly unknown[]): DistinctValue[] {
  const byKey = new Map<string, DistinctValue>();
  for (const value of values) {
    if (!isCategoryValue(value) || value === "") {
      continue;
    }
    const key = String(value),
      existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { count: 1, value });
    } else {
      existing.count += 1;
    }
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      right.count - left.count || String(left.value).localeCompare(String(right.value)),
  );
}

/** Finite numbers among the values; numeric strings count (CSV imports often carry them). */
export function numericValues(values: readonly unknown[]): number[] {
  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numbers.push(value);
    } else if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        numbers.push(parsed);
      }
    }
  }
  return numbers;
}

/** Rounds a break to a readable precision relative to the data's spread. */
function niceRound(value: number, spread: number): number {
  if (spread === 0) {
    return value;
  }
  const digits = Math.max(0, 2 - Math.floor(Math.log10(spread)));
  return Number(value.toFixed(Math.min(digits, 10)));
}

/** Strictly increasing, deduplicated breaks (`step` needs ascending stops). */
function strictlyIncreasing(breaks: number[]): number[] {
  const result: number[] = [];
  for (const value of breaks) {
    if (result.length === 0 || value > result[result.length - 1]) {
      result.push(value);
    }
  }
  return result;
}

/**
 * Upper thresholds splitting the values into `classes` classes — class i
 * covers values below `breaks[i]`, the last class the rest (the `step`
 * expression's semantics). Fewer breaks come back when the data can't
 * support that many distinct classes; an empty array means one class.
 */
export function classBreaks(
  values: readonly number[],
  classes: number,
  method: "equal" | "quantile",
): number[] {
  if (values.length === 0 || classes < 2) {
    return [];
  }
  const sorted = values.toSorted((left, right) => left - right),
    min = sorted[0],
    max = sorted[sorted.length - 1],
    spread = max - min;
  if (spread === 0) {
    return [];
  }
  if (method === "quantile") {
    return quantileBreaks(sorted, classes);
  }
  const raw = Array.from(
    { length: classes - 1 },
    (_, index) => min + (spread * (index + 1)) / classes,
  );
  return strictlyIncreasing(
    raw.map((value) => niceRound(value, spread)).filter((value) => value > min && value <= max),
  );
}

/** The smallest value in `sorted` strictly above `floor`, or undefined. */
function nextAbove(sorted: readonly number[], floor: number): number | undefined {
  return sorted.find((value) => value > floor);
}

/**
 * Quantile thresholds over sorted values, using data values as breaks (so
 * no class is empty by construction). Heavily tied data would repeat a
 * threshold; a repeat moves up to the next distinct value instead, so tied
 * data still splits wherever it can.
 */
function quantileBreaks(sorted: readonly number[], classes: number): number[] {
  const breaks: number[] = [];
  let floor = sorted[0];
  for (let index = 1; index < classes; index += 1) {
    let candidate: number | undefined =
      sorted[Math.min(sorted.length - 1, Math.floor((index / classes) * sorted.length))];
    if (candidate <= floor) {
      candidate = nextAbove(sorted, floor);
    }
    if (candidate === undefined) {
      break;
    }
    breaks.push(candidate);
    floor = candidate;
  }
  return breaks;
}

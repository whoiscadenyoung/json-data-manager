import type { Aggregate } from "#convex/appBuilder/validators";

/**
 * Client-side aggregation for chart and stat widgets — pure, React-free.
 * Rows are entry `data` records; values are coerced the forgiving way a
 * spreadsheet would (numeric strings count as numbers, blanks are skipped).
 */

export type DataRecord = Record<string, unknown>;

export const BLANK_LABEL = "(blank)";
export const OTHER_LABEL = "Other";

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  avg: "Average",
  count: "Count",
  max: "Maximum",
  min: "Minimum",
  sum: "Sum",
};

/** A finite number from a stored value, or undefined (blank, text, NaN). */
export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** The category label one value groups under. */
export function groupLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return BLANK_LABEL;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  // oxlint-disable-next-line typescript/no-base-to-string -- primitives only: nullish and objects return above.
  return String(value);
}

interface Accumulator {
  rows: number;
  values: number;
  sum: number;
  min: number;
  max: number;
}

function emptyAccumulator(): Accumulator {
  return { max: -Infinity, min: Infinity, rows: 0, sum: 0, values: 0 };
}

function accumulate(acc: Accumulator, value: number | undefined): Accumulator {
  if (value === undefined) {
    return { ...acc, rows: acc.rows + 1 };
  }
  return {
    max: Math.max(acc.max, value),
    min: Math.min(acc.min, value),
    rows: acc.rows + 1,
    sum: acc.sum + value,
    values: acc.values + 1,
  };
}

function merge(a: Accumulator, b: Accumulator): Accumulator {
  return {
    max: Math.max(a.max, b.max),
    min: Math.min(a.min, b.min),
    rows: a.rows + b.rows,
    sum: a.sum + b.sum,
    values: a.values + b.values,
  };
}

/** The aggregate's value, or null when no row carried a number (min/max/avg of nothing). */
function finish(acc: Accumulator, aggregate: Aggregate): number | null {
  switch (aggregate) {
    case "count": {
      return acc.rows;
    }
    case "sum": {
      return acc.sum;
    }
    case "avg": {
      return acc.values === 0 ? null : acc.sum / acc.values;
    }
    case "min": {
      return acc.values === 0 ? null : acc.min;
    }
    case "max": {
      return acc.values === 0 ? null : acc.max;
    }
  }
}

/** One headline number over every row — the stat widget. */
export function computeStat(
  rows: readonly DataRecord[],
  aggregate: Aggregate,
  field: string | undefined,
): number | null {
  if (aggregate !== "count" && field === undefined) {
    return null;
  }
  let acc = emptyAccumulator();
  for (const row of rows) {
    acc = accumulate(acc, field === undefined ? undefined : numericValue(row[field]));
  }
  return finish(acc, aggregate);
}

export interface ChartGroup {
  label: string;
  value: number;
}

export interface GroupOptions {
  groupBy: string;
  aggregate: Aggregate;
  valueField?: string;
  sort: "value-desc" | "label-asc";
  limit: number;
}

/** Natural label order: numeric labels numerically, the rest alphabetically, blanks last. */
function compareLabels(a: string, b: string): number {
  if (a === BLANK_LABEL || b === BLANK_LABEL) {
    return a === b ? 0 : a === BLANK_LABEL ? 1 : -1;
  }
  const na = numericValue(a),
    nb = numericValue(b);
  if (na !== undefined && nb !== undefined) {
    return na - nb;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Groups rows by `groupBy` and aggregates each group — the chart widget.
 * Groups past `limit` fold into one "Other" group, aggregated over the
 * folded ROWS (so an average of Other is a true average, not an average of
 * averages). Groups whose aggregate is null are dropped.
 */
export function groupRows(rows: readonly DataRecord[], options: GroupOptions): ChartGroup[] {
  const field = options.valueField,
    groups = new Map<string, Accumulator>();
  for (const row of rows) {
    const label = groupLabel(row[options.groupBy]),
      value = field === undefined ? undefined : numericValue(row[field]);
    groups.set(label, accumulate(groups.get(label) ?? emptyAccumulator(), value));
  }
  const finished = [...groups].flatMap(([label, acc]) => {
    const value = finish(acc, options.aggregate);
    return value === null ? [] : [{ acc, label, value }];
  });
  // Rank by value to pick which groups survive the limit, then present in
  // the requested order.
  const ranked = finished.toSorted((a, b) => b.value - a.value),
    kept = ranked.slice(0, options.limit),
    folded = ranked.slice(options.limit),
    ordered =
      options.sort === "label-asc"
        ? kept.toSorted((a, b) => compareLabels(a.label, b.label))
        : kept,
    result = ordered.map(({ label, value }) => ({ label, value }));
  if (folded.length > 0) {
    const otherValue = finish(
      folded.reduce((sum, group) => merge(sum, group.acc), emptyAccumulator()),
      options.aggregate,
    );
    if (otherValue !== null) {
      result.push({ label: OTHER_LABEL, value: otherValue });
    }
  }
  return result;
}

const compactFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }),
  fullFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** A number for an axis tick or headline: compact past 10k (12.3K), otherwise up to 2 decimals. */
export function formatNumber(value: number): string {
  return Math.abs(value) >= 10_000 ? compactFormatter.format(value) : fullFormatter.format(value);
}

/**
 * A headline number for the stat widget. Min/max of a year-like field (a
 * whole number from 1000 to 2999 — "oldest park founded") reads as a year,
 * so it skips the thousands separator: 1872, not 1,872.
 */
export function formatStatValue(value: number, aggregate: Aggregate): string {
  const yearLike =
    (aggregate === "min" || aggregate === "max") &&
    Number.isInteger(value) &&
    value >= 1000 &&
    value <= 2999;
  return yearLike ? String(value) : formatNumber(value);
}

/** The full-precision form, for tooltips and table views. */
export function formatNumberFull(value: number): string {
  return fullFormatter.format(value);
}

/**
 * The pure rollup engine — the group-by half of the transform engine
 * (docs/derived-datasets-design.md §4.2, §6; roadmap issue #98), sibling to
 * lookup.ts under the one engine interface (spec.ts: "One engine
 * interface").
 *
 * Contract: `applyRollup(operation, rows)` returns `{ rows, diagnostics }`
 * and never mutates its inputs (§2: one pure engine, two executors,
 * client-side). Rows are generic records — NOT the component's
 * `DatasetEntryRow`; adapting those onto this shape is the row-resolution
 * seam's job. The module imports only the shared coercion utilities and
 * spec types: zero app or Convex dependencies.
 *
 * Invariants, each pinned by a test in `rollup.test.ts`:
 *
 * - **Purity and composition.** Input arrays and rows are never written;
 *   every output row is a fresh object; output rows are ordinary records,
 *   so the engine accepts its own output as the next call's input — the
 *   join-back chain (rollup, then `applyLookup` over a parent dataset) is
 *   two pure calls (§3:87-90), proven in `composition.test.ts`.
 * - **Key hygiene is 0.4's, not reinvented here.** Every group-by cell goes
 *   through `normalizeKey` (../coercion.ts) — number `42` and string `"42"`
 *   group together; strings are trimmed and case-folded, never
 *   numeric-normalized (`"007"` never groups with number `7`), so
 *   "Aldine" and "aldine" form ONE group (the shared key policy, applied to
 *   grouping — pinned because it is surprising if unpinned).
 * - **Keyless rows are dropped, and counted.** A row lacking a key in ANY
 *   `groupBy` column has no group. The recorded decision (issue open item:
 *   own group vs drop): it is DROPPED and reported in
 *   `diagnostics.keylessRows` — the join-side precedent "a keyless row is
 *   an unmatched row, never a crash" (coercion.ts:63-65) extends to
 *   grouping, and the shared key doctrine has no null-key bucket to seat
 *   it in. The count keeps the drop from ever being silent.
 * - **One row per group (§4.2), in first-seen order.** Groups emerge in
 *   the order their normalized key first appears in the input — the lookup
 *   engine's convention and an input-derived, run-stable order (stage 6's
 *   re-run-and-refreeze sync needs determinism, not Map accident). Key
 *   columns in the output keep their SOURCE names and carry the group's
 *   RAW first-seen value (pre-normalization), so the join-back key resolves
 *   unambiguously (issue decision 6) and displays as authored.
 * - **Measure null semantics — the issue's open item (b), pinned here:**
 *   - `count` is the group's ROW count (COUNT(*)): every grouped row
 *     counts, whatever its cells hold.
 *   - The numeric four (`sum`, `avg`, `min`, `max`) read cells through
 *     `coerceNumber` (../coercion.ts — the shared numeric-cell policy, so a
 *     numeric column's string cells count: "42" is 42). Cells with no
 *     numeric value (null, absent, whitespace-only, non-numeric strings,
 *     booleans, objects, NaN) are EXCLUDED, never an error.
 *   - A group with NO numeric cells yields `null` for sum/avg/min/max —
 *     SQL's NULL, not 0: 0 would be fabricated data in an export.
 *   - `avg`'s denominator is the cells WITH a numeric value; nulls and
 *     non-numerics count in neither numerator nor denominator.
 *   - `min`/`max` are numeric-only (coerceNumber-filtered). A lexicographic
 *     string min/max would be a new doc-fixed measure, not a silent policy
 *     change — recorded here so the absence is a decision.
 *   - `distinctCount` counts distinct NORMALIZED KEYS (`normalizeKey`) —
 *     the same identity the grouping itself uses, so "Aldine"/"aldine"
 *     count once. Keyless cells contribute nothing (COUNT(DISTINCT) skips
 *     NULL); a group with no keyed cells yields 0.
 * - **Degenerate shapes are pinned, not accidental.** Empty `groupBy` is
 *   the total aggregate: one group of every keyed row. Empty `measures` is
 *   the distinct-group projection: key columns only. Two measures whose
 *   `<namespace>.<alias>` columns coincide: last one written wins.
 * - **Output naming (issue decision 6).** Measure columns land as
 *   `<namespace>.<alias>` (default namespace "rollup" — see
 *   `RollupOperation.namespace`); the namespaced form keeps exports and
 *   popup labels unambiguous exactly as the lookup engine's enrichment
 *   does. A downstream lookup namespaces AGAIN over these columns
 *   (`<its namespace>.<this column>`) — verbose but unambiguous by design.
 * - **No geometry emission.** A `geometrySource` rule addresses LOOKUP
 *   operations (spec.ts): a rollup group spans many source rows, so it has
 *   no single row's geometry to resolve. Geometry resolves on the lookup
 *   step of a chain (lookup.ts), not here.
 * - **Diagnostics.** `totalSourceRows` is the input row count, `groups` the
 *   group count (== `rows.length`, stated for the preview's groups-in /
 *   rows-out rate, the match-rate analog), `keylessRows` the dropped rows.
 * - **Never throws.** Unlike lookup (whose `onDuplicateKey: "error"` can
 *   reject), nothing in a rollup spec is rejectable: every cell either has
 *   a key/numeric value or is excluded by the recorded semantics.
 */
import { coerceNumber, normalizeKey } from "../coercion.js";
import type { RollupMeasure, RollupOperation } from "./spec.js";

/**
 * Group-count diagnostics for one `applyRollup` call — the match-rate
 * analog of `LookupDiagnostics`: rows in, groups out, rows lost to the
 * keyless drop.
 */
export interface RollupDiagnostics {
  /** Rows in — the denominator of the groups-per-row reduction. */
  totalSourceRows: number;
  /** Groups out — == `rows.length`, stated so previews need not re-derive it. */
  groups: number;
  /** Rows dropped for lacking a key in at least one `groupBy` column (the recorded keyless decision). */
  keylessRows: number;
}

/** The result of one `applyRollup` call: one fresh row per group plus diagnostics. */
export interface RollupResult {
  /** One row per group, first-seen order — never the input rows, never the input array. */
  rows: Record<string, unknown>[];
  diagnostics: RollupDiagnostics;
}

/**
 * One measure's running aggregate state — PER MEASURE, never shared: two
 * measures over the same column must each count a row's cell once (a shared
 * accumulator would double-count; caught by test).
 */
interface MeasureAccumulator {
  /** Group rows seen — the `count` measure's value. */
  rowCount: number;
  /** Cells whose `coerceNumber` exists — `avg`'s denominator. */
  numericCount: number;
  /** Running sum of numeric cells — `sum`'s value, `avg`'s numerator. */
  sum: number;
  /** Smallest numeric cell, or nothing when none has arrived yet. */
  min: number | undefined;
  /** Largest numeric cell, or nothing when none has arrived yet. */
  max: number | undefined;
  /** Distinct normalized keys seen — the `distinctCount` measure's basis. */
  distinct: Set<string>;
}

/** A fresh, empty accumulator; only the fields its `fn` reads are ever written. */
function newAccumulator(): MeasureAccumulator {
  return {
    rowCount: 0,
    numericCount: 0,
    sum: 0,
    min: undefined,
    max: undefined,
    distinct: new Set<string>(),
  };
}

/** One group under construction: its raw first-seen keys and one accumulator per measure, index-parallel to `operation.measures`. */
interface GroupState {
  keyValues: Record<string, unknown>;
  accumulators: MeasureAccumulator[];
}

/**
 * The normalized composite key of one row, or `undefined` when any groupBy
 * cell has no key (the row is keyless — dropped, counted). `JSON.stringify`
 * of the per-column keys is collision-free for string arrays, so composite
 * keys cannot fake a match across different column combinations.
 */
function compositeKeyOf(
  row: Record<string, unknown>,
  groupBy: readonly string[],
): string | undefined {
  const keys: string[] = [];
  for (const column of groupBy) {
    const key = normalizeKey(row[column]);
    if (key === undefined) {
      return undefined;
    }
    keys.push(key);
  }
  return JSON.stringify(keys);
}

/** The group's raw first-seen key cells, keyed by source column name. */
function keyValuesOf(
  row: Record<string, unknown>,
  groupBy: readonly string[],
): Record<string, unknown> {
  const keyValues: Record<string, unknown> = {};
  for (const column of groupBy) {
    keyValues[column] = row[column];
  }
  return keyValues;
}

/** One row's contribution to one measure (see the module doc's null semantics). */
function accumulate(
  accumulator: MeasureAccumulator,
  measure: RollupMeasure,
  row: Record<string, unknown>,
): void {
  if (measure.fn === "count") {
    accumulator.rowCount += 1;
    return;
  }
  if (measure.fn === "distinctCount") {
    const key = normalizeKey(row[measure.column]);
    if (key !== undefined) {
      accumulator.distinct.add(key);
    }
    return;
  }
  const numeric = coerceNumber(row[measure.column]);
  if (numeric === undefined) {
    return;
  }
  accumulator.numericCount += 1;
  accumulator.sum += numeric;
  if (accumulator.min === undefined || numeric < accumulator.min) {
    accumulator.min = numeric;
  }
  if (accumulator.max === undefined || numeric > accumulator.max) {
    accumulator.max = numeric;
  }
}

/** The group's final value for one measure, per the module doc's null semantics. */
function measureValue(accumulator: MeasureAccumulator, measure: RollupMeasure): unknown {
  if (measure.fn === "count") {
    return accumulator.rowCount;
  }
  if (measure.fn === "distinctCount") {
    return accumulator.distinct.size;
  }
  if (accumulator.numericCount === 0) {
    return null;
  }
  if (measure.fn === "sum") {
    return accumulator.sum;
  }
  if (measure.fn === "avg") {
    return accumulator.sum / accumulator.numericCount;
  }
  if (measure.fn === "min") {
    return accumulator.min;
  }
  return accumulator.max;
}

/** The namespaced output column of one measure (`<namespace>.<alias>`, §6). */
function measureColumn(namespace: string, measure: RollupMeasure): string {
  return `${namespace}.${measure.alias}`;
}

/**
 * Applies one rollup operation (§4.2): group `rows` by the operation's key
 * columns (0.4 coercion), compute its measures per group, and return one
 * fresh row per group — first-seen order, key columns in their source form,
 * measures under `<namespace>.<alias>`. Inputs are never mutated; the
 * result feeds the next engine call of a chain (the join-back composition,
 * §3:87-90). Never throws — see the module doc for every pinned semantics
 * decision.
 */
export function applyRollup(
  operation: RollupOperation,
  rows: readonly Record<string, unknown>[],
): RollupResult {
  const namespace = operation.namespace ?? "rollup",
    groups = new Map<string, GroupState>();
  let keylessRows = 0;
  for (const row of rows) {
    const composite = compositeKeyOf(row, operation.groupBy);
    if (composite === undefined) {
      keylessRows += 1;
      continue;
    }
    let group = groups.get(composite);
    if (group === undefined) {
      group = {
        keyValues: keyValuesOf(row, operation.groupBy),
        accumulators: operation.measures.map(newAccumulator),
      };
      groups.set(composite, group);
    }
    for (let index = 0; index < operation.measures.length; index += 1) {
      accumulate(group.accumulators[index], operation.measures[index], row);
    }
  }
  const outRows: Record<string, unknown>[] = [];
  for (const group of groups.values()) {
    const outRow: Record<string, unknown> = { ...group.keyValues };
    for (let index = 0; index < operation.measures.length; index += 1) {
      outRow[measureColumn(namespace, operation.measures[index])] = measureValue(
        group.accumulators[index],
        operation.measures[index],
      );
    }
    outRows.push(outRow);
  }
  return {
    rows: outRows,
    diagnostics: {
      totalSourceRows: rows.length,
      groups: groups.size,
      keylessRows,
    },
  };
}

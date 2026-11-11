/**
 * "Type as currency" on an existing dataset (issue #292): the pure plan the
 * Structure tab previews before anything is written. Parsing is the shared
 * `@caden/data-core/currency` policy, so the import flow, this action and the
 * views typing agree on every value.
 *
 * Never silent (#279): the plan lists every value that won't parse, and the
 * caller only applies when there are none — or when the user explicitly
 * chose to clear them (`clearFailures`).
 */
import { CURRENCY_KEYWORD, parseCurrencyValue } from "@caden/data-core/currency";
import type { CurrencySymbol } from "@caden/data-core/currency";

export interface CurrencyPlanRow {
  id: string;
  data: unknown;
}

export interface CurrencyPlanFailure {
  id: string;
  /** 1-based position in the dataset's row order. */
  row: number;
  value: unknown;
  reason: string;
}

export interface CurrencyPlan {
  field: string;
  /** The one symbol the values used (`""` when none carried one), or `null` when they mixed symbols. */
  symbol: string | null;
  converted: number;
  blanks: number;
  failures: CurrencyPlanFailure[];
  /** Rows that hold the field at all. */
  present: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeIncludes(property: unknown, type: string): boolean {
  if (!isRecord(property)) {
    return false;
  }
  const declared = property.type;
  return Array.isArray(declared) ? declared.includes(type) : declared === type;
}

/** Top-level properties declared as text — the columns "Type as currency" can apply to. */
export function textColumnsOf(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }
  return Object.entries(schema.properties)
    .filter(([, property]) => typeIncludes(property, "string"))
    .map(([name]) => name);
}

interface Tally {
  converted: number;
  blanks: number;
  present: number;
  symbols: Set<CurrencySymbol>;
  failures: CurrencyPlanFailure[];
}

function tallyRow(tally: Tally, row: CurrencyPlanRow, index: number, field: string): void {
  if (!isRecord(row.data) || !(field in row.data)) {
    return;
  }
  tally.present += 1;
  const value = row.data[field],
    parsed = parseCurrencyValue(value);
  if (parsed.kind === "number") {
    tally.converted += 1;
    if (parsed.symbol !== null) {
      tally.symbols.add(parsed.symbol);
    }
  } else if (parsed.kind === "blank") {
    tally.blanks += 1;
  } else {
    tally.failures.push({ id: row.id, reason: parsed.reason, row: index + 1, value });
  }
}

/** What typing `field` as currency would do to `rows`. Pure. */
export function planCurrencyTyping(rows: readonly CurrencyPlanRow[], field: string): CurrencyPlan {
  const tally: Tally = { blanks: 0, converted: 0, failures: [], present: 0, symbols: new Set() };
  for (const [index, row] of rows.entries()) {
    tallyRow(tally, row, index, field);
  }
  const symbols = [...tally.symbols];
  return {
    blanks: tally.blanks,
    converted: tally.converted,
    failures: tally.failures,
    field,
    present: tally.present,
    symbol: symbols.length > 1 ? null : (symbols[0] ?? ""),
  };
}

/** Why the plan can't be applied as is, or `undefined` when it can. */
export function planBlocker(plan: CurrencyPlan, clearFailures: boolean): string | undefined {
  if (plan.symbol === null) {
    return "The values mix currency symbols, so this can't be one amount column.";
  }
  if (plan.converted === 0) {
    return "No value in this column reads as an amount.";
  }
  if (plan.failures.length > 0 && !clearFailures) {
    return "Some values don't read as amounts. Fix them first, or choose to clear them.";
  }
  return undefined;
}

/**
 * The `rewrite_entry_field` payload: every row holding the field gets its
 * parsed number, or `null` (the key is removed) for blank text and — only
 * when `clearFailures` — for values that didn't parse.
 */
export function rewriteValuesOf(
  rows: readonly CurrencyPlanRow[],
  field: string,
  clearFailures: boolean,
): Array<{ id: string; value: number | null }> {
  const values: Array<{ id: string; value: number | null }> = [];
  for (const row of rows) {
    if (!isRecord(row.data) || !(field in row.data)) {
      continue;
    }
    const parsed = parseCurrencyValue(row.data[field]);
    if (parsed.kind === "number") {
      values.push({ id: row.id, value: parsed.value });
    } else if (parsed.kind === "blank" || clearFailures) {
      values.push({ id: row.id, value: null });
    }
  }
  return values;
}

/**
 * The stored schema with `field` as a currency column: `type: number` plus
 * the `x-currency` display hint; the field leaves `required` when some rows
 * will no longer carry it.
 */
export function currencySchemaOf(
  schema: unknown,
  plan: CurrencyPlan,
  clearFailures: boolean,
  rowCount: number,
): Record<string, unknown> {
  const base = isRecord(schema) ? schema : {},
    properties = isRecord(base.properties) ? base.properties : {},
    previous = isRecord(properties[plan.field]) ? properties[plan.field] : {},
    { type: _type, ...kept } = isRecord(previous) ? previous : {},
    remaining = plan.converted + (clearFailures ? 0 : plan.failures.length),
    everyRowKeepsIt = remaining === rowCount,
    required = Array.isArray(base.required)
      ? base.required.filter((key) => key !== plan.field || everyRowKeepsIt)
      : undefined;
  return {
    ...base,
    properties: {
      ...properties,
      [plan.field]: { ...kept, type: "number", [CURRENCY_KEYWORD]: plan.symbol ?? "" },
    },
    ...(required === undefined ? {} : { required }),
  };
}

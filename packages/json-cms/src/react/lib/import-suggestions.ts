/**
 * Import-time typing suggestions (issue #291): pure helpers behind the
 * importer's Suggestions card. Detection itself lives in `@caden/data-core`
 * (`detectCurrencyColumns`, `detectCoordinateColumns`) so the import flow,
 * the schema editor and the views typing share one policy. Nothing here runs
 * on its own: every change is a per-column confirmation (the #279 "never
 * silent" posture), and declining leaves the import byte-identical.
 */
import { convertCurrencyColumn } from "@caden/data-core/currency";
import type { CurrencyConversionFailure } from "@caden/data-core/currency";

export interface SuggestionRow {
  data: unknown;
}

export type CurrencyApplyResult<T extends SuggestionRow> =
  | { ok: true; rows: T[]; schemaJson: string; converted: number; blanks: number }
  | { ok: false; failures: CurrencyConversionFailure[]; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `"n/a" (row 3), "TBD" (row 9) and 4 more` — the first few failures, 1-based rows. */
export function describeFailures(
  failures: readonly CurrencyConversionFailure[],
  shown = 3,
): string {
  const head = failures
      .slice(0, shown)
      .map((failure) => `${JSON.stringify(failure.value)} (row ${failure.index + 1})`)
      .join(", "),
    rest = failures.length - shown;
  return rest > 0 ? `${head} and ${rest} more` : head;
}

/**
 * The schema with `field` typed as a number. Its title/description and any
 * other annotations stay; the type becomes `number`, and `field` leaves
 * `required` when some rows no longer carry it (blank text and nulls are
 * dropped by the conversion, never stored as 0).
 */
function retypeSchema(
  schemaJson: string,
  field: string,
  rows: readonly Record<string, unknown>[],
): string {
  const parsed: unknown = JSON.parse(schemaJson);
  if (!isRecord(parsed) || !isRecord(parsed.properties)) {
    return schemaJson;
  }
  const previous = parsed.properties[field],
    everyRowHasIt = rows.every((row) => field in row),
    {
      type: _oldType,
      items: _items,
      properties: _props,
      ...kept
    } = isRecord(previous) ? previous : {},
    required = Array.isArray(parsed.required)
      ? parsed.required.filter((key) => key !== field || everyRowHasIt)
      : undefined;
  return JSON.stringify(
    {
      ...parsed,
      properties: { ...parsed.properties, [field]: { ...kept, type: "number" } },
      ...(required === undefined ? {} : { required }),
    },
    null,
    2,
  );
}

/**
 * Types one currency-shaped column: every value is rewritten through the
 * shared parser and the schema property becomes a number. Refuses (and
 * returns the failing rows) while ANY non-blank value doesn't parse — the
 * caller shows them and changes nothing.
 */
export function applyCurrencySuggestion<T extends SuggestionRow>(
  rows: readonly T[],
  schemaJson: string,
  field: string,
): CurrencyApplyResult<T> {
  const data = rows.map((row) => (isRecord(row.data) ? row.data : {})),
    conversion = convertCurrencyColumn(data, field);
  if (conversion.failures.length > 0) {
    return {
      failures: conversion.failures,
      message: `${conversion.failures.length.toLocaleString()} value${conversion.failures.length === 1 ? "" : "s"} in "${field}" won't parse as an amount: ${describeFailures(conversion.failures)}. Fix them in the file and re-upload, or keep the column as text.`,
      ok: false,
    };
  }
  return {
    blanks: conversion.blanks,
    converted: conversion.converted,
    ok: true,
    rows: rows.map((row, index) =>
      isRecord(row.data) ? { ...row, data: conversion.rows[index] } : row,
    ),
    schemaJson: retypeSchema(schemaJson, field, conversion.rows),
  };
}

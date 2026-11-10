import { ViewCompileError, ViewStepNotSupportedError } from "./errors.js";
import { fieldJson, fieldNumber, fieldPresent, fieldText, ParamBag } from "./sql-util.js";
import type { StepKind, Measure } from "./types.js";

function requireField(measure: Measure): string {
  if (measure.field === undefined || measure.field === "") {
    throw new ViewCompileError(`Measure "${measure.as}" (${measure.fn}) needs a field.`);
  }
  return measure.field;
}

function minMax(fn: "min" | "max", row: string, bag: ParamBag, field: string): string {
  const json = fieldJson(row, bag, field);
  const text = fieldText(row, bag, field);
  const number = fieldNumber(row, bag, field);
  const hasString = `count(*) filter (where jsonb_typeof(${json}) = 'string')`;
  return `(case when ${hasString} = 0 then to_jsonb(${fn}(${number})) else to_jsonb(${fn}(${text})) end)`;
}

/**
 * The aggregate expression (a jsonb value) for one measure over the rows of
 * the current group, where `row` is the jsonb row column. Measures `topBy`
 * and `text` belong to later issues.
 */
export function measureAggregate(
  measure: Measure,
  row: string,
  bag: ParamBag,
  step: StepKind,
): string {
  switch (measure.fn) {
    case "count":
      return measure.field === undefined
        ? "to_jsonb(count(*))"
        : `to_jsonb(count(*) filter (where ${fieldPresent(row, bag, measure.field)}))`;
    case "countDistinct": {
      const field = requireField(measure);
      const json = fieldJson(row, bag, field);
      return `to_jsonb(count(distinct ${json}) filter (where ${fieldPresent(row, bag, field)}))`;
    }
    case "sum":
      return `to_jsonb(sum(${fieldNumber(row, bag, requireField(measure))}))`;
    case "avg":
      return `to_jsonb(avg(${fieldNumber(row, bag, requireField(measure))}))`;
    case "min":
    case "max":
      return minMax(measure.fn, row, bag, requireField(measure));
    default:
      throw new ViewStepNotSupportedError(step, `measure:${measure.fn}`);
  }
}

/** The coalesce fallback for a measure (count defaults to 0), or undefined for none. */
export function measureEmpty(measure: Measure): string | number | boolean | null | undefined {
  const empty = measure.emptyValue ?? undefined;
  if (empty === undefined && measure.fn === "count") {
    return 0;
  }
  return empty;
}

/** Wrap a jsonb expression in the measure's emptyValue coalesce, when it has one. */
export function withEmpty(expr: string, measure: Measure, bag: ParamBag): string {
  const empty = measureEmpty(measure);
  return empty === undefined ? expr : `coalesce(${expr}, ${bag.jsonb(empty)})`;
}

/** One measure as a jsonb SQL expression with its emptyValue applied. */
export function measureExpr(measure: Measure, row: string, bag: ParamBag, step: StepKind): string {
  return withEmpty(measureAggregate(measure, row, bag, step), measure, bag);
}

/**
 * Typed SQL fragments for the `calculate` compiler and the coercions
 * between them. A `json` value is a jsonb expression whose type is only known
 * at run time (a field the input schema does not type); it is coerced
 * leniently where it is used. Every function here emits SQL text built from
 * other fragments only: user values arrive as bind parameters upstream.
 */

import { ExpressionError } from "./calc-ast.js";
import type { SourceSpan } from "./calc-ast.js";

export type ExprType = "number" | "string" | "boolean" | "json" | "null";

export interface Typed {
  sql: string;
  type: ExprType;
}

const NUMERIC_TEXT = String.raw`'^\s*-?[0-9]+(\.[0-9]+)?\s*$'`;

function mismatch(want: string, got: ExprType, span: SourceSpan): ExpressionError {
  const have = got === "string" ? "text" : got;
  return new ExpressionError(`Expected ${want} but this is ${have}.`, span);
}

function numberFromText(text: string): string {
  return `(case when ${text} ~ ${NUMERIC_TEXT} then btrim(${text})::numeric end)`;
}

export function asNumber(value: Typed, span: SourceSpan): string {
  switch (value.type) {
    case "number":
      return value.sql;
    case "null":
      return "null::numeric";
    case "string":
      return numberFromText(value.sql);
    case "json": {
      const text = `(${value.sql} #>> '{}')`;
      return `(case jsonb_typeof(${value.sql}) when 'number' then (${value.sql})::numeric when 'string' then ${numberFromText(text)} end)`;
    }
    default:
      throw mismatch("a number", value.type, span);
  }
}

export function asText(value: Typed, span: SourceSpan): string {
  switch (value.type) {
    case "string":
      return value.sql;
    case "null":
      return "null::text";
    case "number":
      return `trim_scale(${value.sql})::text`;
    case "boolean":
      return `(${value.sql})::text`;
    case "json":
      return `(${value.sql} #>> '{}')`;
    default:
      throw mismatch("text", value.type, span);
  }
}

export function asBoolean(value: Typed, span: SourceSpan): string {
  switch (value.type) {
    case "boolean":
      return value.sql;
    case "null":
      return "null::boolean";
    case "json":
      return `(case jsonb_typeof(${value.sql}) when 'boolean' then (${value.sql})::boolean end)`;
    default:
      throw mismatch("true or false", value.type, span);
  }
}

export function asJson(value: Typed): string {
  return value.type === "json"
    ? value.sql
    : value.type === "null"
      ? "null::jsonb"
      : `to_jsonb(${value.sql})`;
}

/** Coerce a value to `type`. */
export function coerce(value: Typed, type: ExprType, span: SourceSpan): Typed {
  switch (type) {
    case "number":
      return { sql: asNumber(value, span), type };
    case "string":
      return { sql: asText(value, span), type };
    case "boolean":
      return { sql: asBoolean(value, span), type };
    case "json":
      return { sql: asJson(value), type };
    default:
      return value;
  }
}

/**
 * The common type of several values (coalesce / case branches / comparisons):
 * the one concrete type they share, `json` when only json and null remain,
 * `null` when all are null. Two different concrete types are an error.
 */
export function unify(values: { value: Typed; span: SourceSpan }[], span: SourceSpan): ExprType {
  const concrete = new Set<ExprType>();
  let sawJson = false;
  for (const { value } of values) {
    if (value.type === "json") {
      sawJson = true;
    } else if (value.type !== "null") {
      concrete.add(value.type);
    }
  }
  if (concrete.size > 1) {
    const names = [...concrete].map((type) => (type === "string" ? "text" : type));
    throw new ExpressionError(`These values have different types (${names.join(" and ")}).`, span);
  }
  const [only] = [...concrete];
  if (only !== undefined) {
    return only;
  }
  return sawJson ? "json" : "null";
}

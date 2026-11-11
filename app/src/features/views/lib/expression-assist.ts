import {
  analyzeExpression,
  analyzeSqlStep,
  EXPRESSION_FUNCTIONS,
  type FieldType,
} from "@caden/data-core/views";
import type { CodeCompletion, CodeEditorDiagnostic } from "@caden/ui/components/code-editor";

/**
 * Pure helpers behind the Calculate and SQL step forms (#302): the live
 * parse/type check of an expression, autocomplete candidates, and the SQL
 * step's positioned errors. No React; the forms feed the results to the
 * CodeMirror editor and to a plain-text error list.
 */

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a field is written in an expression: bare when it is a plain identifier, else "double quoted". */
export function fieldReference(name: string): string {
  return PLAIN_NAME.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** Autocomplete candidates for an expression: the row's fields, then the allowed functions. */
export function expressionCompletions(fields: readonly string[] | undefined): CodeCompletion[] {
  const fieldItems: CodeCompletion[] = (fields ?? []).map((name) => ({
    label: name,
    apply: fieldReference(name),
    detail: "field",
    type: "variable",
  }));
  const functionItems: CodeCompletion[] = EXPRESSION_FUNCTIONS.map((fn) => ({
    label: fn.name,
    apply: `${fn.name}(`,
    detail: fn.signature,
    info: fn.description,
    type: "function",
  }));
  return [...fieldItems, ...functionItems];
}

export interface ExpressionCheck {
  /** Problems with their source offsets; empty when the expression is fine (or blank). */
  problems: (CodeEditorDiagnostic & { message: string })[];
  /** The type the expression produces, once it parses and checks. */
  type: FieldType | undefined;
}

/**
 * Parse and type-check an expression against the row's fields. An unknown row
 * shape (`fields` undefined) accepts every field name. Blank text is not an
 * error here: the step shows "needs input" for that.
 */
export function checkExpression(
  src: string,
  fields: readonly string[] | undefined,
): ExpressionCheck {
  if (src.trim() === "") {
    return { problems: [], type: undefined };
  }
  const known = fields === undefined ? undefined : new Set(fields);
  const result = analyzeExpression(src, (name) =>
    known === undefined || known.has(name) ? "unknown" : undefined,
  );
  if (result.ok) {
    return { problems: [], type: result.type };
  }
  return {
    problems: result.errors.map((error) => ({
      from: error.start,
      to: error.end,
      message: error.message,
    })),
    type: undefined,
  };
}

export const TYPE_LABELS: Record<FieldType, string> = {
  string: "text",
  number: "number",
  integer: "whole number",
  boolean: "true / false",
  date: "date",
  unknown: "depends on the data",
};

export interface SqlCheck {
  problems: CodeEditorDiagnostic[];
  /** The output column names when the query is valid. */
  columns: string[] | undefined;
}

/** The names a SQL step may read: the previous step and one CTE per declared input. */
export function sqlTableNames(aliases: readonly string[]): string[] {
  return ["prev", ...aliases.map((alias) => `in_${alias}`)];
}

/** Check a SQL step's text with the compiler's own analysis. Blank text is not an error here. */
export function checkSql(query: string, aliases: readonly string[]): SqlCheck {
  if (query.trim() === "") {
    return { problems: [], columns: undefined };
  }
  const result = analyzeSqlStep(query, [...aliases]);
  if (result.ok) {
    return { problems: [], columns: result.analysis.columns };
  }
  return {
    problems: result.errors.map((error) => ({
      from: error.start,
      to: error.end,
      message: error.message,
    })),
    columns: undefined,
  };
}

/** Autocomplete candidates for SQL: the table names a step can read and the row columns. */
export function sqlCompletions(aliases: readonly string[]): CodeCompletion[] {
  const tables: CodeCompletion[] = sqlTableNames(aliases).map((name) => ({
    label: name,
    detail: name === "prev" ? "the previous step's rows" : "an input's rows",
    type: "class",
  }));
  const columns: CodeCompletion[] = [
    { label: "d", detail: "all of a row's fields (jsonb)", type: "variable" },
    { label: "row_id", detail: "the row's id", type: "variable" },
    { label: "geom", detail: "the row's geometry", type: "variable" },
  ];
  return [...tables, ...columns];
}

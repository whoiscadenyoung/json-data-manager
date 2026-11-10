/**
 * The `calculate` step: parse + type-check an expression (for the validator
 * and the editor) and compile it into one CTE over the previous step.
 */

import { ExpressionError } from "./calc-ast.js";
import type { ExprDiagnostic, ExprNode } from "./calc-ast.js";
import { parseExpression } from "./calc-parser.js";
import { compileExpr, expressionToJson, fieldTypeOf } from "./calc-sql.js";
import type { ExprContext } from "./calc-sql.js";
import { ViewCompileError } from "./errors.js";
import { buildObject, ParamBag } from "./sql-util.js";
import type { FieldType } from "./types.js";

/** Resolves a field's type; `undefined` means the row has no such field. */
export type FieldResolver = (name: string) => FieldType | undefined;

export type ExpressionAnalysis =
  | { ok: true; ast: ExprNode; type: FieldType }
  | { ok: false; errors: ExprDiagnostic[] };

function compileTyped(ast: ExprNode, ctx: ExprContext): { sql: string; type: FieldType } {
  const typed = compileExpr(ast, ctx);
  return { sql: expressionToJson(typed), type: fieldTypeOf(typed.type) };
}

/**
 * Parse and type-check an expression against the fields of the current row.
 * Never throws; problems come back with source offsets. Used by the
 * validator, and by the editor for live errors and the result type.
 */
export function analyzeExpression(src: string, fieldType: FieldResolver): ExpressionAnalysis {
  const parsed = parseExpression(src);
  if (!parsed.ok) {
    return parsed;
  }
  try {
    const { type } = compileTyped(parsed.ast, { row: "d", bag: new ParamBag(), fieldType });
    return { ok: true, ast: parsed.ast, type };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return {
        ok: false,
        errors: [{ message: error.message, start: error.start, end: error.end }],
      };
    }
    throw error;
  }
}

/** Every field name an expression reads (for dependency hints and autocomplete). */
export function expressionFieldRefs(ast: ExprNode): string[] {
  const names = new Set<string>();
  const walk = (node: ExprNode): void => {
    switch (node.type) {
      case "field":
        names.add(node.name);
        break;
      case "unary":
      case "isNull":
        walk(node.operand);
        break;
      case "binary":
        walk(node.left);
        walk(node.right);
        break;
      case "call":
        for (const arg of node.args) {
          walk(arg);
        }
        break;
      case "case":
        for (const branch of node.branches) {
          walk(branch.when);
          walk(branch.result);
        }
        if (node.otherwise !== undefined) {
          walk(node.otherwise);
        }
        break;
      default:
        break;
    }
  };
  walk(ast);
  return [...names];
}

/** `s{n} as (select row_id, d || jsonb_build_object(field, <expr>) as d, geom from prev)`. */
export function compileCalculate(
  step: { field: string; expr: string },
  prev: string,
  out: string,
  bag: ParamBag,
  fieldType: FieldResolver,
): string {
  const analysis = parseExpression(step.expr);
  if (!analysis.ok) {
    const [first] = analysis.errors;
    throw new ViewCompileError(`calculate "${step.field}": ${first.message} (at ${first.start}).`);
  }
  try {
    const { sql } = compileTyped(analysis.ast, { row: "d", bag, fieldType });
    const value = buildObject([{ key: step.field, value: sql }], bag);
    // `offset 0` is an optimization fence: without it Postgres inlines this CTE into the next
    // step and copies the `d || ...` expression into every reference, which blows up
    // exponentially across chained calculate steps.
    return `${out} as (
  select row_id, d || ${value} as d, geom
  from ${prev}
  offset 0
)`;
  } catch (error) {
    if (error instanceof ExpressionError) {
      throw new ViewCompileError(
        `calculate "${step.field}": ${error.message} (at ${error.start}).`,
      );
    }
    throw error;
  }
}

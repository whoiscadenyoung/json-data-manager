/**
 * AST -> SQL for `calculate` (docs/views-design.md §4, ADR 0028 D13). The
 * expression is never spliced in as text: the SQL is rebuilt from the parsed
 * AST, every literal and every field key is a bind parameter, and function
 * names come from a closed allowlist (`EXPRESSION_FUNCTIONS`).
 */

import { ExpressionError } from "./calc-ast.js";
import type { BinaryOp, ExprNode, SourceSpan } from "./calc-ast.js";
import { asBoolean, asJson, asNumber, asText, coerce, unify } from "./calc-coerce.js";
import type { ExprType, Typed } from "./calc-coerce.js";
import { fieldJson, ParamBag } from "./sql-util.js";
import type { FieldType } from "./types.js";

export type { ExprType, Typed } from "./calc-coerce.js";

export interface ExprContext {
  /** The jsonb row column, e.g. `d`. */
  row: string;
  bag: ParamBag;
  /**
   * The input type of a field: a `FieldType`, or `undefined` when the row is
   * known not to have that field (reported as an error).
   */
  fieldType: (name: string) => FieldType | undefined;
}

export interface FunctionInfo {
  name: string;
  signature: string;
  description: string;
}

/** The closed function allowlist, for the editor's autocomplete and docs. */
export const EXPRESSION_FUNCTIONS: FunctionInfo[] = [
  {
    name: "coalesce",
    signature: "coalesce(a, b, ...)",
    description: "The first value that is not empty.",
  },
  {
    name: "concat",
    signature: "concat(a, b, ...)",
    description: "Join values into text (empty values are skipped).",
  },
  { name: "lower", signature: "lower(text)", description: "Lowercase text." },
  { name: "upper", signature: "upper(text)", description: "Uppercase text." },
  { name: "trim", signature: "trim(text)", description: "Remove leading and trailing spaces." },
  {
    name: "round",
    signature: "round(number, digits?)",
    description: "Round to a number of decimal places (default 0).",
  },
  {
    name: "year",
    signature: "year(date)",
    description: "The year of an ISO date (YYYY-MM-DD...).",
  },
  { name: "month", signature: "month(date)", description: "The month (1-12) of an ISO date." },
  { name: "day", signature: "day(date)", description: "The day of the month of an ISO date." },
  {
    name: "if",
    signature: "if(condition, a, b)",
    description: "a when the condition is true, otherwise b.",
  },
];

const DATE_TEXT = String.raw`'^\d{4}-\d{2}-\d{2}'`;

function compileField(node: ExprNode & { type: "field" }, ctx: ExprContext): Typed {
  const kind = ctx.fieldType(node.name);
  if (kind === undefined) {
    throw new ExpressionError(`Unknown field "${node.name}".`, node);
  }
  const json = fieldJson(ctx.row, ctx.bag, node.name);
  switch (kind) {
    case "number":
    case "integer":
      return {
        type: "number",
        sql: `(case when jsonb_typeof(${json}) = 'number' then (${json})::numeric end)`,
      };
    case "string":
    case "date":
      return { type: "string", sql: `(${ctx.row} ->> ${ctx.bag.text(node.name)})` };
    case "boolean":
      return {
        type: "boolean",
        sql: `(case when jsonb_typeof(${json}) = 'boolean' then (${json})::boolean end)`,
      };
    default:
      return { type: "json", sql: `nullif(${json}, 'null'::jsonb)` };
  }
}

function compileLiteral(node: ExprNode, ctx: ExprContext): Typed {
  switch (node.type) {
    case "number":
      if (!Number.isFinite(node.value)) {
        throw new ExpressionError("This number is out of range.", node);
      }
      return { type: "number", sql: ctx.bag.add(node.value, "numeric") };
    case "string":
      return { type: "string", sql: ctx.bag.text(node.value) };
    case "boolean":
      return { type: "boolean", sql: ctx.bag.add(node.value, "boolean") };
    default:
      return { type: "null", sql: "null" };
  }
}

const ARITHMETIC = new Set<BinaryOp>(["+", "-", "*", "/"]);
const SQL_COMPARE: Record<string, string> = {
  "=": "=",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

function compileArithmetic(node: ExprNode & { type: "binary" }, left: Typed, right: Typed): Typed {
  const l = asNumber(left, node.left);
  const r = asNumber(right, node.right);
  // Division by zero is an empty value, never a run-time error.
  const sql = node.op === "/" ? `(${l} / nullif(${r}, 0))` : `(${l} ${node.op} ${r})`;
  return { type: "number", sql };
}

function compileComparison(node: ExprNode & { type: "binary" }, left: Typed, right: Typed): Typed {
  const type = unify(
    [
      { value: left, span: node.left },
      { value: right, span: node.right },
    ],
    node,
  );
  const op = SQL_COMPARE[node.op];
  const l = coerce(left, type === "null" ? "json" : type, node.left);
  const r = coerce(right, type === "null" ? "json" : type, node.right);
  return { type: "boolean", sql: `(${l.sql} ${op} ${r.sql})` };
}

function compileBinary(node: ExprNode & { type: "binary" }, ctx: ExprContext): Typed {
  const left = compileExpr(node.left, ctx);
  const right = compileExpr(node.right, ctx);
  if (ARITHMETIC.has(node.op)) {
    return compileArithmetic(node, left, right);
  }
  if (node.op === "and" || node.op === "or") {
    const l = asBoolean(left, node.left);
    const r = asBoolean(right, node.right);
    return { type: "boolean", sql: `(${l} ${node.op} ${r})` };
  }
  return compileComparison(node, left, right);
}

function compileCase(node: ExprNode & { type: "case" }, ctx: ExprContext): Typed {
  const branches = node.branches.map((branch) => ({
    when: compileExpr(branch.when, ctx),
    whenSpan: branch.when as SourceSpan,
    result: compileExpr(branch.result, ctx),
    resultSpan: branch.result as SourceSpan,
  }));
  const otherwise = node.otherwise === undefined ? undefined : compileExpr(node.otherwise, ctx);
  const values = branches.map((b) => ({ value: b.result, span: b.resultSpan }));
  if (otherwise !== undefined && node.otherwise !== undefined) {
    values.push({ value: otherwise, span: node.otherwise });
  }
  const type = unify(values, node);
  const target = type === "null" ? "json" : type;
  const parts = branches.map(
    (b) =>
      `when ${asBoolean(b.when, b.whenSpan)} then ${coerce(b.result, target, b.resultSpan).sql}`,
  );
  const tail =
    otherwise === undefined || node.otherwise === undefined
      ? ""
      : ` else ${coerce(otherwise, target, node.otherwise).sql}`;
  return { type: target, sql: `(case ${parts.join(" ")}${tail} end)` };
}

// --- functions --------------------------------------------------------------

interface CallArgs {
  node: ExprNode & { type: "call" };
  values: Typed[];
}

type FunctionBuilder = (call: CallArgs) => Typed;

function textArg(call: CallArgs, index: number): string {
  return asText(call.values[index], call.node.args[index]);
}

function numberArg(call: CallArgs, index: number): string {
  return asNumber(call.values[index], call.node.args[index]);
}

function buildPicks(call: CallArgs): { type: ExprType; sqls: string[] } {
  const picks = call.values.map((value, i) => ({ value, span: call.node.args[i] }));
  const type = unify(picks, call.node);
  const target = type === "null" ? "json" : type;
  return { type: target, sqls: picks.map((p) => coerce(p.value, target, p.span).sql) };
}

function datePart(part: string): FunctionBuilder {
  return (call) => {
    const text = textArg(call, 0);
    const date = `(case when ${text} ~ ${DATE_TEXT} then left(${text}, 10)::date end)`;
    return { type: "number", sql: `extract(${part} from ${date})` };
  };
}

function ifBuilder(call: CallArgs): Typed {
  const [cond, a, b] = call.values;
  const [condNode, aNode, bNode] = call.node.args;
  const type = unify(
    [
      { value: a, span: aNode },
      { value: b, span: bNode },
    ],
    call.node,
  );
  const target = type === "null" ? "json" : type;
  const sql = `(case when ${asBoolean(cond, condNode)} then ${coerce(a, target, aNode).sql} else ${coerce(b, target, bNode).sql} end)`;
  return { type: target, sql };
}

function roundBuilder(call: CallArgs): Typed {
  const value = numberArg(call, 0);
  const digits = call.values.length > 1 ? `, (${numberArg(call, 1)})::int` : "";
  return { type: "number", sql: `round(${value}${digits})` };
}

interface FunctionSpec {
  min: number;
  /** Infinity for variadic functions. */
  max: number;
  build: FunctionBuilder;
}

const FUNCTIONS: Record<string, FunctionSpec> = {
  coalesce: {
    min: 1,
    max: Infinity,
    build: (call) => {
      const { type, sqls } = buildPicks(call);
      return { type, sql: `coalesce(${sqls.join(", ")})` };
    },
  },
  concat: {
    min: 1,
    max: Infinity,
    build: (call) => ({
      type: "string",
      sql: `concat(${call.values.map((_, i) => textArg(call, i)).join(", ")})`,
    }),
  },
  lower: {
    min: 1,
    max: 1,
    build: (call) => ({ type: "string", sql: `lower(${textArg(call, 0)})` }),
  },
  upper: {
    min: 1,
    max: 1,
    build: (call) => ({ type: "string", sql: `upper(${textArg(call, 0)})` }),
  },
  trim: {
    min: 1,
    max: 1,
    build: (call) => ({ type: "string", sql: `btrim(${textArg(call, 0)})` }),
  },
  round: { min: 1, max: 2, build: roundBuilder },
  year: { min: 1, max: 1, build: datePart("year") },
  month: { min: 1, max: 1, build: datePart("month") },
  day: { min: 1, max: 1, build: datePart("day") },
  if: { min: 3, max: 3, build: ifBuilder },
};

function arityMessage(name: string, spec: FunctionSpec): string {
  if (spec.max === Infinity) {
    return `${name}() needs at least ${spec.min} argument${spec.min === 1 ? "" : "s"}.`;
  }
  if (spec.min === spec.max) {
    return `${name}() takes exactly ${spec.min} argument${spec.min === 1 ? "" : "s"}.`;
  }
  return `${name}() takes ${spec.min} to ${spec.max} arguments.`;
}

function compileCall(node: ExprNode & { type: "call" }, ctx: ExprContext): Typed {
  const spec = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : undefined;
  if (spec === undefined) {
    const known = EXPRESSION_FUNCTIONS.map((fn) => fn.name).join(", ");
    throw new ExpressionError(`Unknown function "${node.name}". Available: ${known}.`, node);
  }
  if (node.args.length < spec.min || node.args.length > spec.max) {
    throw new ExpressionError(arityMessage(node.name, spec), node);
  }
  const values = node.args.map((arg) => compileExpr(arg, ctx));
  return spec.build({ node, values });
}

/** Compile an expression node to a typed SQL fragment. Throws `ExpressionError`. */
export function compileExpr(node: ExprNode, ctx: ExprContext): Typed {
  switch (node.type) {
    case "field":
      return compileField(node, ctx);
    case "unary": {
      const operand = compileExpr(node.operand, ctx);
      return node.op === "-"
        ? { type: "number", sql: `(- ${asNumber(operand, node.operand)})` }
        : { type: "boolean", sql: `(not ${asBoolean(operand, node.operand)})` };
    }
    case "binary":
      return compileBinary(node, ctx);
    case "isNull": {
      const operand = compileExpr(node.operand, ctx);
      return { type: "boolean", sql: `(${operand.sql} is ${node.negated ? "not " : ""}null)` };
    }
    case "call":
      return compileCall(node, ctx);
    case "case":
      return compileCase(node, ctx);
    default:
      return compileLiteral(node, ctx);
  }
}

/** The jsonb value to store for a calculated field. */
export function expressionToJson(value: Typed): string {
  return value.type === "null" ? "'null'::jsonb" : asJson(value);
}

/** The field type a calculated value is recorded as. */
export function fieldTypeOf(type: ExprType): FieldType {
  return type === "number" || type === "string" || type === "boolean" ? type : "unknown";
}

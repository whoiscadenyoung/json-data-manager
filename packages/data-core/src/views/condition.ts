import { ViewCompileError } from "./errors.js";
import { fieldJson, ParamBag } from "./sql-util.js";
import type { Condition, ConditionLeaf } from "./types.js";

const ORDER_OPS = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

type OrderOp = keyof typeof ORDER_OPS;

export function isLeaf(condition: Condition): condition is ConditionLeaf {
  return "field" in condition && "op" in condition;
}

/** Compile a filter tree against the jsonb column `row` into a boolean SQL expression. */
export function compileCondition(condition: Condition, row: string, bag: ParamBag): string {
  if (isLeaf(condition)) {
    return compileLeaf(condition, row, bag);
  }
  if ("not" in condition) {
    return `not (${compileCondition(condition.not, row, bag)})`;
  }
  if ("and" in condition) {
    return joinBranch(condition.and, "and", "true", row, bag);
  }
  return joinBranch(condition.or, "or", "false", row, bag);
}

function joinBranch(
  children: Condition[],
  op: "and" | "or",
  empty: string,
  row: string,
  bag: ParamBag,
): string {
  if (children.length === 0) {
    return empty;
  }
  return children.map((child) => `(${compileCondition(child, row, bag)})`).join(` ${op} `);
}

function isOrderOp(op: string): op is OrderOp {
  return op in ORDER_OPS;
}

function compileLeaf(leaf: ConditionLeaf, row: string, bag: ParamBag): string {
  const json = fieldJson(row, bag, leaf.field);
  const { op } = leaf;
  if (op === "isNull") {
    return `(${json} is null or jsonb_typeof(${json}) = 'null')`;
  }
  if (op === "notNull") {
    return `(${json} is not null and jsonb_typeof(${json}) <> 'null')`;
  }
  if (isOrderOp(op)) {
    return compileOrder(json, ORDER_OPS[op], leaf.value, bag);
  }
  return compileEquality(json, leaf, bag);
}

function compileEquality(json: string, leaf: ConditionLeaf, bag: ParamBag): string {
  switch (leaf.op) {
    case "eq":
      return `${json} = ${bag.jsonb(leaf.value)}`;
    case "neq":
      return `${json} is distinct from ${bag.jsonb(leaf.value)}`;
    case "in":
      return `${json} in (select jsonb_array_elements(${bag.jsonb(leaf.value)}))`;
    case "contains":
      return `strpos(lower(${json} #>> '{}'), lower(${bag.text(String(leaf.value))})) > 0`;
    default:
      throw new ViewCompileError(`Unsupported filter operator "${leaf.op}".`);
  }
}

function compileOrder(json: string, sqlOp: string, value: unknown, bag: ParamBag): string {
  if (typeof value === "number") {
    const number = `(case when jsonb_typeof(${json}) = 'number' then ${json}::numeric end)`;
    return `${number} ${sqlOp} ${bag.add(value, "numeric")}`;
  }
  if (typeof value === "string") {
    const text = `(case when jsonb_typeof(${json}) = 'string' then ${json} #>> '{}' end)`;
    return `${text} ${sqlOp} ${bag.text(value)}`;
  }
  throw new ViewCompileError("Ordering comparisons need a number or string value.");
}

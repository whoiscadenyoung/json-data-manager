import { containsUuid } from "./sql-util.js";
import { isNonEmptyString, isRecord } from "./validate-issues.js";
import type { Issues } from "./validate-issues.js";

const CONDITION_OPS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "isNull",
  "notNull",
]);
const MEASURE_FNS = new Set([
  "count",
  "countDistinct",
  "sum",
  "avg",
  "min",
  "max",
  "topBy",
  "text",
]);
const MATCH_FLAGS = ["trim", "caseFold", "collapseSpace", "stripDiacritics"] as const;
const MULTI_MODES = new Set(["first", "last", "summarize", "spread", "text", "list", "error"]);

// --- conditions -------------------------------------------------------------

export function validateConditionShape(cond: unknown, path: string, issues: Issues): void {
  if (!isRecord(cond)) {
    issues.add(path, "A condition must be an object.");
    return;
  }
  if (Array.isArray(cond.and)) {
    validateBranch(cond.and, `${path}.and`, issues);
  } else if (Array.isArray(cond.or)) {
    validateBranch(cond.or, `${path}.or`, issues);
  } else if ("not" in cond) {
    validateConditionShape(cond.not, `${path}.not`, issues);
  } else {
    validateLeafShape(cond, path, issues);
  }
}

function validateBranch(children: unknown[], path: string, issues: Issues): void {
  if (children.length === 0) {
    issues.add(path, "Empty and/or groups are not allowed.");
  }
  for (const [i, child] of children.entries()) {
    validateConditionShape(child, `${path}[${i}]`, issues);
  }
}

function validateLeafShape(cond: Record<string, unknown>, path: string, issues: Issues): void {
  if (!isNonEmptyString(cond.field)) {
    issues.add(`${path}.field`, "A condition needs a field.");
  }
  if (typeof cond.op !== "string" || !CONDITION_OPS.has(cond.op)) {
    issues.add(`${path}.op`, "Unknown condition operator.");
    return;
  }
  validateLeafValue(cond.op, cond.value, path, issues);
}

function validateLeafValue(op: string, value: unknown, path: string, issues: Issues): void {
  const problem = leafValueProblem(op, value);
  if (problem !== undefined) {
    issues.add(`${path}.value`, problem);
  }
}

function leafValueProblem(op: string, value: unknown): string | undefined {
  if (op === "isNull" || op === "notNull") {
    return undefined;
  }
  if (op === "in") {
    return Array.isArray(value) ? undefined : '"in" needs an array value.';
  }
  if (op === "contains") {
    return typeof value === "string" ? undefined : '"contains" needs a string value.';
  }
  if (value === null || value === undefined) {
    return `"${op}" needs a value (use isNull / notNull for empty checks).`;
  }
  return orderingProblem(op, value);
}

function orderingProblem(op: string, value: unknown): string | undefined {
  const scalar = typeof value === "number" || typeof value === "string";
  return op === "eq" || op === "neq" || scalar
    ? undefined
    : "Ordering comparisons need a number or string.";
}

// --- measures ---------------------------------------------------------------

export function validateMeasures(measures: unknown, path: string, issues: Issues): void {
  if (!Array.isArray(measures)) {
    issues.add(path, "measures must be an array.");
    return;
  }
  const seen = new Set<string>();
  for (const [i, measure] of measures.entries()) {
    validateMeasure(measure, `${path}[${i}]`, seen, issues);
  }
}

function validateMeasure(measure: unknown, path: string, seen: Set<string>, issues: Issues): void {
  if (!isRecord(measure)) {
    issues.add(path, "A measure must be an object.");
    return;
  }
  if (!isNonEmptyString(measure.as)) {
    issues.add(`${path}.as`, "A measure needs an output name (as).");
  } else if (seen.has(measure.as)) {
    issues.add(`${path}.as`, `Duplicate measure name "${measure.as}".`);
  } else {
    seen.add(measure.as);
  }
  if (typeof measure.fn !== "string" || !MEASURE_FNS.has(measure.fn)) {
    issues.add(`${path}.fn`, "Unknown measure function.");
    return;
  }
  if (measure.fn !== "count" && !isNonEmptyString(measure.field)) {
    issues.add(`${path}.field`, `"${measure.fn}" needs a field.`);
  }
  if (measure.fn === "topBy" && !isNonEmptyString(measure.by)) {
    issues.add(`${path}.by`, '"topBy" needs a by field.');
  }
}

// --- joins ------------------------------------------------------------------

function validateOn(on: unknown, path: string, issues: Issues): void {
  if (!Array.isArray(on) || on.length === 0) {
    issues.add(path, "A join needs at least one key pair (on).");
    return;
  }
  for (const [i, pair] of on.entries()) {
    if (!isRecord(pair) || !isNonEmptyString(pair.left) || !isNonEmptyString(pair.right)) {
      issues.add(`${path}[${i}]`, "Each key pair needs a left and a right field.");
    }
  }
}

function validateMatching(matching: unknown, path: string, issues: Issues): void {
  if (!isRecord(matching)) {
    issues.add(path, "A join needs key matching options.");
    return;
  }
  for (const flag of MATCH_FLAGS) {
    if (typeof matching[flag] !== "boolean") {
      issues.add(`${path}.${flag}`, "Must be true or false.");
    }
  }
  const map = matching.manualMap;
  if (map === undefined) {
    return;
  }
  const valid =
    Array.isArray(map) &&
    map.every((e) => isRecord(e) && typeof e.from === "string" && typeof e.to === "string");
  if (!valid) {
    issues.add(`${path}.manualMap`, "manualMap must be a list of { from, to } strings.");
  }
}

function validateSpread(mm: Record<string, unknown>, path: string, issues: Issues): void {
  if (!isNonEmptyString(mm.by) || !isNonEmptyString(mm.value)) {
    issues.add(path, "spread needs by and value fields.");
  }
  const columns = mm.columns;
  if (!Array.isArray(columns) || columns.length === 0) {
    issues.add(`${path}.columns`, "spread needs at least one declared column.");
    return;
  }
  const seen = new Set<string>();
  for (const [i, column] of columns.entries()) {
    const at = `${path}.columns[${i}]`;
    if (!isRecord(column) || typeof column.category !== "string" || !isNonEmptyString(column.as)) {
      issues.add(at, "Each spread column needs a category and an output name (as).");
    } else if (seen.has(column.as)) {
      issues.add(at, `Duplicate spread column "${column.as}".`);
    } else {
      seen.add(column.as);
    }
  }
}

function validateOrderBy(orderBy: unknown, path: string, issues: Issues): void {
  if (orderBy === undefined) {
    return;
  }
  const valid =
    Array.isArray(orderBy) &&
    orderBy.every(
      (s) =>
        isRecord(s) &&
        isNonEmptyString(s.field) &&
        (s.direction === undefined || s.direction === "asc" || s.direction === "desc"),
    );
  if (!valid) {
    issues.add(path, "orderBy must be a list of { field, direction? }.");
  }
}

function hasValidMode(mm: unknown): mm is Record<string, unknown> & { mode: string } {
  return isRecord(mm) && typeof mm.mode === "string" && MULTI_MODES.has(mm.mode);
}

function validateMultiMatch(mm: unknown, path: string, issues: Issues): void {
  if (!hasValidMode(mm)) {
    issues.add(path, "multiMatch needs a valid mode.");
    return;
  }
  if (mm.mode === "first" || mm.mode === "last") {
    validateOrderBy(mm.orderBy, `${path}.orderBy`, issues);
  } else if (mm.mode === "summarize") {
    validateMeasures(mm.measures, `${path}.measures`, issues);
  } else if (mm.mode === "spread") {
    validateSpread(mm, path, issues);
  } else if (
    mm.mode === "text" &&
    (!isNonEmptyString(mm.field) || typeof mm.separator !== "string")
  ) {
    issues.add(path, "text needs a field and a separator.");
  }
}

function validateJoin(
  step: Record<string, unknown>,
  path: string,
  aliases: Set<string>,
  issues: Issues,
): void {
  const right = step.right;
  if (!isRecord(right) || typeof right.input !== "string") {
    issues.add(`${path}.right`, "A join needs a right side with an input alias.");
  } else if (!aliases.has(right.input)) {
    issues.add(`${path}.right.input`, `Unknown input alias "${right.input}".`);
  }
  if (isRecord(right) && right.steps !== undefined && !Array.isArray(right.steps)) {
    issues.add(`${path}.right.steps`, "A sub-pipeline must be a list of steps.");
  }
  validateOn(step.on, `${path}.on`, issues);
  validateMatching(step.matching, `${path}.matching`, issues);
  if (step.type !== "left" && step.type !== "inner") {
    issues.add(`${path}.type`, 'Join type must be "left" or "inner".');
  }
  validateMultiMatch(step.multiMatch, `${path}.multiMatch`, issues);
  validateJoinNames(step, path, issues);
}

function validateJoinNames(step: Record<string, unknown>, path: string, issues: Issues): void {
  const { fields, prefix } = step;
  if (fields !== undefined && !(Array.isArray(fields) && fields.every(isNonEmptyString))) {
    issues.add(`${path}.fields`, "fields must be a list of field names.");
  }
  if (prefix !== undefined && (typeof prefix !== "string" || containsUuid(prefix))) {
    issues.add(`${path}.prefix`, "prefix must be a readable name, never a dataset id.");
  }
}

// --- other steps ------------------------------------------------------------

function validateGroupBy(step: Record<string, unknown>, path: string, issues: Issues): void {
  const by = step.by;
  if (!Array.isArray(by) || by.length === 0 || !by.every(isNonEmptyString)) {
    issues.add(`${path}.by`, "groupBy needs at least one field.");
  }
  validateMeasures(step.measures, `${path}.measures`, issues);
}

function validateSelect(step: Record<string, unknown>, path: string, issues: Issues): void {
  const fields = step.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    issues.add(`${path}.fields`, "select needs at least one field.");
    return;
  }
  const seen = new Set<string>();
  for (const [i, field] of fields.entries()) {
    const at = `${path}.fields[${i}]`;
    if (!isRecord(field) || !isNonEmptyString(field.from) || !isNonEmptyString(field.as)) {
      issues.add(at, "Each select field needs from and as.");
    } else if (seen.has(field.as)) {
      issues.add(at, `Duplicate output name "${field.as}".`);
    } else {
      seen.add(field.as);
    }
  }
}

/** Shape checks for one step (no field-scope checks; see validate-fields). */
export function validateStepShape(
  step: Record<string, unknown>,
  path: string,
  aliases: Set<string>,
  issues: Issues,
): void {
  switch (step.kind) {
    case "filter":
      validateConditionShape(step.where, `${path}.where`, issues);
      break;
    case "join":
      validateJoin(step, path, aliases, issues);
      break;
    case "groupBy":
      validateGroupBy(step, path, issues);
      break;
    case "select":
      validateSelect(step, path, issues);
      break;
    case "calculate":
      if (!isNonEmptyString(step.field)) {
        issues.add(`${path}.field`, "calculate needs a field name.");
      }
      if (!isNonEmptyString(step.expr)) {
        issues.add(`${path}.expr`, "calculate needs an expression (text).");
      }
      break;
    case "sql":
      if (!isNonEmptyString(step.query)) {
        issues.add(`${path}.query`, "sql needs a query.");
      }
      break;
    default:
      issues.add(`${path}.kind`, "Unknown step kind.");
  }
}

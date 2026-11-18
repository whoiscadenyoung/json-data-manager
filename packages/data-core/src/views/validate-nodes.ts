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

function validateRef(
  value: unknown,
  path: string,
  ids: Set<string>,
  issues: Issues,
  what = "node",
): void {
  if (!isNonEmptyString(value)) {
    issues.add(path, `Pick a ${what}.`);
  } else if (!ids.has(value)) {
    issues.add(path, `Unknown node "${value}".`);
  }
}

function validateJoin(
  step: Record<string, unknown>,
  path: string,
  ids: Set<string>,
  issues: Issues,
): void {
  validateRef(step.left, `${path}.left`, ids, issues);
  validateRef(step.right, `${path}.right`, ids, issues);
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

function isTag(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function validateOneEdit(
  edit: unknown,
  at: string,
  seen: Set<string>,
  outputs: Set<string>,
  issues: Issues,
): void {
  if (!isRecord(edit) || !isNonEmptyString(edit.from)) {
    issues.add(at, "Each column edit needs a `from` field name.");
    return;
  }
  if (seen.has(edit.from)) {
    issues.add(at, `Field "${edit.from}" is edited more than once.`);
  }
  seen.add(edit.from);
  if ("exclude" in edit) {
    if (edit.exclude !== true || "as" in edit) {
      issues.add(at, "An exclude edit must be `exclude: true` with no `as`.");
    }
  } else if (!isNonEmptyString(edit.as)) {
    issues.add(at, `Column "${edit.from}" needs an output name (\`as\`) or exclude.`);
  } else if (outputs.has(edit.as)) {
    issues.add(at, `Two fields are renamed to "${edit.as}"; pick one.`);
  } else {
    outputs.add(edit.as);
  }
}

function validateColumnEdits(edits: unknown, path: string, issues: Issues): void {
  if (edits === undefined) {
    return;
  }
  if (!Array.isArray(edits)) {
    issues.add(path, "Column edits must be a list.");
    return;
  }
  const seen = new Set<string>();
  const outputs = new Set<string>();
  for (const [i, edit] of edits.entries()) {
    validateOneEdit(edit, `${path}[${i}]`, seen, outputs, issues);
  }
}

function validateStackInput(input: unknown, at: string, ids: Set<string>, issues: Issues): void {
  if (!isRecord(input)) {
    issues.add(at, "Each stack input needs a node.");
    return;
  }
  validateRef(input.node, `${at}.node`, ids, issues);
  if (!isTag(input.tag)) {
    issues.add(`${at}.tag`, "A tag must be a string, number, boolean or null.");
  }
  validateColumnEdits(input.columns, `${at}.columns`, issues);
}

function validateStack(
  step: Record<string, unknown>,
  path: string,
  ids: Set<string>,
  issues: Issues,
): void {
  const inputs = step.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    issues.add(`${path}.inputs`, "A stack needs at least one input.");
  } else {
    for (const [i, input] of inputs.entries()) {
      validateStackInput(input, `${path}.inputs[${i}]`, ids, issues);
    }
  }
  if (step.tagField !== undefined && !isNonEmptyString(step.tagField)) {
    issues.add(`${path}.tagField`, "tagField must be a field name.");
  }
  const tagged = Array.isArray(inputs) && inputs.some((s) => isRecord(s) && s.tag !== undefined);
  if (tagged && step.tagField === undefined) {
    issues.add(`${path}.tagField`, "Tags need a tagField to be written to.");
  }
}

function validateColumns(step: Record<string, unknown>, path: string, issues: Issues): void {
  if (!Array.isArray(step.edits)) {
    issues.add(`${path}.edits`, "columns needs a list of edits.");
  } else {
    validateColumnEdits(step.edits, `${path}.edits`, issues);
  }
  const only = step.only;
  if (only !== undefined && !(Array.isArray(only) && only.every(isNonEmptyString))) {
    issues.add(`${path}.only`, "only must be a list of field names.");
  }
}

function validateCalculate(step: Record<string, unknown>, path: string, issues: Issues): void {
  const fields = step.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    issues.add(`${path}.fields`, "calculate needs at least one field.");
    return;
  }
  for (const [i, field] of fields.entries()) {
    const at = `${path}.fields[${i}]`;
    if (!isRecord(field) || !isNonEmptyString(field.field)) {
      issues.add(`${at}.field`, "calculate needs a field name.");
    } else if (!isNonEmptyString(field.expr)) {
      issues.add(`${at}.expr`, "calculate needs an expression (text).");
    }
  }
}

function validateSql(
  step: Record<string, unknown>,
  path: string,
  ids: Set<string>,
  issues: Issues,
): void {
  if (!isNonEmptyString(step.query)) {
    issues.add(`${path}.query`, "sql needs a query.");
  }
  const reads = step.reads;
  if (reads === undefined) {
    return;
  }
  if (!Array.isArray(reads)) {
    issues.add(`${path}.reads`, "reads must be a list of node ids.");
    return;
  }
  for (const [i, read] of reads.entries()) {
    validateRef(read, `${path}.reads[${i}]`, ids, issues);
  }
}

type Shape = (
  node: Record<string, unknown>,
  path: string,
  ids: Set<string>,
  issues: Issues,
) => void;

const SHAPES: Record<string, Shape> = {
  source: (node, path, _ids, issues) => validateSourceRef(node.ref, `${path}.ref`, issues),
  filter: (node, path, _ids, issues) => validateConditionShape(node.where, `${path}.where`, issues),
  join: validateJoin,
  stack: validateStack,
  groupBy: (node, path, _ids, issues) => validateGroupBy(node, path, issues),
  columns: (node, path, _ids, issues) => validateColumns(node, path, issues),
  calculate: (node, path, _ids, issues) => validateCalculate(node, path, issues),
  sql: validateSql,
};

const OWN_INPUTS = new Set(["source", "join", "stack"]);

/** Shape checks for one node (no field-scope checks; see validate-fields). */
export function validateNodeShape(
  node: Record<string, unknown>,
  path: string,
  ids: Set<string>,
  issues: Issues,
): void {
  if (node.label !== undefined && typeof node.label !== "string") {
    issues.add(`${path}.label`, "A label must be text.");
  }
  const shape =
    typeof node.kind === "string" && Object.hasOwn(SHAPES, node.kind)
      ? SHAPES[node.kind]
      : undefined;
  if (shape === undefined) {
    issues.add(`${path}.kind`, "Unknown node kind.");
    return;
  }
  if (!OWN_INPUTS.has(String(node.kind))) {
    validateRef(node.from, `${path}.from`, ids, issues);
  }
  shape(node, path, ids, issues);
}

function validateSourceRef(ref: unknown, path: string, issues: Issues): void {
  if (!isRecord(ref) || ref.kind !== "dataset" || !isNonEmptyString(ref.id)) {
    issues.add(path, 'A source needs a ref: { kind: "dataset", id }.');
    return;
  }
  if (ref.version !== undefined && typeof ref.version !== "string") {
    issues.add(`${path}.version`, "Version must be a string.");
  }
}

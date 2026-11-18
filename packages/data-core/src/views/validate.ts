/**
 * Structural and semantic validation of a ViewDefinition (plain TypeScript:
 * this package carries no schema-library dependency). Returns every problem
 * with a JSON-path-style location (`nodes.<id>.<field path>`). Field
 * references are checked against source schemas only when the `inputs`
 * metadata carries `fields`.
 */

import { describeCycle, findCycle } from "./graph.js";
import { containsUuid } from "./sql-util.js";
import type { CompileInputMeta, ValidationResult, ViewDefinition } from "./types.js";
import { checkField, GraphScope } from "./validate-fields.js";
import type { FieldMap } from "./validate-fields.js";
import { Issues, isRecord } from "./validate-issues.js";
import { validateNodeShape } from "./validate-nodes.js";

const ID_PATTERN = /^[a-z0-9_]{1,40}$/;

function validateId(id: string, issues: Issues): void {
  const path = `nodes.${id}`;
  if (!ID_PATTERN.test(id)) {
    issues.add(path, "Node ids use 1-40 lowercase letters, digits or underscores.");
  } else if (containsUuid(id)) {
    issues.add(path, "Node ids must be readable names, never dataset ids.");
  }
}

function validateOutputField(
  field: unknown,
  at: string,
  seen: Set<string>,
  known: FieldMap | undefined,
  issues: Issues,
): void {
  if (!isRecord(field) || typeof field.key !== "string" || field.key === "") {
    issues.add(at, "Each output field needs a key.");
    return;
  }
  if (seen.has(field.key)) {
    issues.add(`${at}.key`, `Duplicate output key "${field.key}".`);
  }
  seen.add(field.key);
  if (field.from !== undefined && (typeof field.from !== "string" || field.from === "")) {
    issues.add(`${at}.from`, "The source field must be a name.");
    return;
  }
  const renamed = field.from !== undefined;
  checkField(known, field.from ?? field.key, `${at}.${renamed ? "from" : "key"}`, issues);
}

function validateOutput(output: unknown, known: FieldMap | undefined, issues: Issues): void {
  const path = "result.output";
  if (!isRecord(output) || !Array.isArray(output.fields)) {
    issues.add(path, "Output needs a fields array and an emptyFields mode.");
    return;
  }
  if (output.emptyFields !== "keep" && output.emptyFields !== "omit") {
    issues.add(`${path}.emptyFields`, 'Must be "keep" or "omit".');
  }
  const seen = new Set<string>();
  for (const [i, field] of output.fields.entries()) {
    validateOutputField(field, `${path}.fields[${i}]`, seen, known, issues);
  }
}

function validateResultNode(
  result: Record<string, unknown>,
  nodes: Record<string, unknown>,
  issues: Issues,
): string | undefined {
  const node = result.node;
  if (typeof node !== "string" || node === "") {
    issues.add("result.node", "Pick the node the view saves.");
    return undefined;
  }
  if (!Object.hasOwn(nodes, node)) {
    issues.add("result.node", `Unknown node "${node}".`);
    return undefined;
  }
  return node;
}

/** Shape-check every node; returns true when all of them are well formed. */
function validateShapes(nodes: Record<string, unknown>, issues: Issues): boolean {
  const ids = new Set(Object.keys(nodes));
  const before = issues.count;
  for (const [id, node] of Object.entries(nodes)) {
    validateId(id, issues);
    if (!isRecord(node) || typeof node.kind !== "string") {
      issues.add(`nodes.${id}`, "Each node needs a kind.");
      continue;
    }
    validateNodeShape(node, `nodes.${id}`, ids, issues);
  }
  return issues.count === before;
}

/** Narrowing after every shape check passed. */
function isDefinition(
  def: Record<string, unknown>,
): def is Record<string, unknown> & ViewDefinition {
  return isRecord(def.nodes) && isRecord(def.result);
}

/** Cycle check, then field checks per node, then the output schema. */
function validateSemantics(
  def: ViewDefinition,
  resultNode: string | undefined,
  inputs: CompileInputMeta[],
  issues: Issues,
): void {
  const cycle = findCycle(def.nodes);
  if (cycle !== undefined) {
    issues.add(`nodes.${cycle[0]}`, `Node "${cycle[0]}" reads itself: ${describeCycle(cycle)}`);
    return;
  }
  const scope = new GraphScope(def.nodes, inputs);
  for (const id of Object.keys(def.nodes)) {
    scope.validateNode(id, issues);
  }
  validateOutput(
    def.result.output,
    resultNode === undefined ? undefined : scope.fieldsOf(resultNode),
    issues,
  );
}

/** Validate an unknown value as a ViewDefinition. */
export function validateViewDefinition(
  def: unknown,
  inputs?: CompileInputMeta[],
): ValidationResult {
  const issues = new Issues();
  if (!isRecord(def)) {
    return { ok: false, errors: [{ path: "", message: "A view definition must be an object." }] };
  }
  if (!isRecord(def.nodes) || Object.keys(def.nodes).length === 0) {
    issues.add("nodes", "A view needs at least one node.");
    return { ok: false, errors: issues.list };
  }
  if (!isRecord(def.result)) {
    issues.add("result", "A view needs a result node.");
    return { ok: false, errors: issues.list };
  }
  const shapesOk = validateShapes(def.nodes, issues);
  const resultNode = validateResultNode(def.result, def.nodes, issues);
  if (shapesOk && isDefinition(def)) {
    validateSemantics(def, resultNode, inputs ?? [], issues);
  } else {
    validateOutput(def.result.output, undefined, issues);
  }
  if (issues.count > 0 || !isDefinition(def)) {
    return { ok: false, errors: issues.list };
  }
  return { ok: true, value: def };
}

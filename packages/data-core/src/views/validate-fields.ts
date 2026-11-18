/**
 * Field-reference checking over the node graph: `fieldsOf(node)` is the
 * memoized set of field names (and types) a node produces, computed from the
 * nodes it reads. Checks are skipped (never an error) once a shape is
 * unknown: a source without `fields` metadata, a bare-`d` sql node, a cycle.
 * The compiler reuses the same scope to learn field types for `calculate`.
 */

import { analyzeExpression } from "./calculate.js";
import { joinPrefix, listKey, prefixed } from "./join-names.js";
import { analyzeSqlStep } from "./sql-step.js";
import type {
  ColumnEdit,
  CompileInputMeta,
  Condition,
  FieldType,
  JoinNode,
  Measure,
  ViewNode,
} from "./types.js";
import { Issues } from "./validate-issues.js";

export type FieldMap = Map<string, FieldType>;

function metaFields(meta: CompileInputMeta | undefined): FieldMap | undefined {
  if (meta === undefined || meta.fields === undefined) {
    return undefined;
  }
  return new Map(meta.fields.map((field) => [field.name, field.type ?? "unknown"]));
}

/** Result type of a measure, given the field types of the rows it aggregates. */
export function measureType(measure: Measure, source: FieldMap | undefined): FieldType {
  switch (measure.fn) {
    case "count":
    case "countDistinct":
    case "sum":
    case "avg":
      return "number";
    case "text":
      return "string";
    default: {
      const ref = measure.field;
      const type = ref === undefined || source === undefined ? undefined : source.get(ref);
      return type ?? "unknown";
    }
  }
}

/**
 * Fields one stack input produces after its column edits. Reports edits of
 * unknown fields and renames that collide with a field that stays.
 */
export function editFields(
  fields: FieldMap,
  edits: ColumnEdit[] | undefined,
  path: string,
  issues: Issues,
): FieldMap {
  if (edits === undefined || edits.length === 0) {
    return fields;
  }
  const out: FieldMap = new Map(fields);
  const moved: [string, FieldType][] = [];
  for (const [i, edit] of edits.entries()) {
    const type = fields.get(edit.from);
    if (type === undefined) {
      issues.add(`${path}[${i}]`, `Unknown field "${edit.from}".`);
      continue;
    }
    out.delete(edit.from);
    if ("as" in edit) {
      moved.push([edit.as, type]);
    }
  }
  for (const [as, type] of moved) {
    if (out.has(as) && fields.has(as)) {
      issues.add(path, `Renaming into "${as}" collides with an existing field of that name.`);
    }
    out.set(as, type);
  }
  return out;
}

type NodeOf<K extends ViewNode["kind"]> = Extract<ViewNode, { kind: K }>;

export class GraphScope {
  private readonly memo = new Map<string, FieldMap | undefined>();
  private readonly visiting = new Set<string>();

  constructor(
    readonly nodes: Record<string, ViewNode>,
    private readonly metas: CompileInputMeta[],
  ) {}

  /** The readable title of a node: a source's dataset title, else its label, else its id. */
  titleOf(id: string): string {
    const node = Object.hasOwn(this.nodes, id) ? this.nodes[id] : undefined;
    const meta = this.metas.find((entry) => entry.node === id);
    if (node !== undefined && node.kind === "source" && meta !== undefined) {
      return meta.title;
    }
    return node !== undefined && node.label !== undefined && node.label !== "" ? node.label : id;
  }

  /** The fields a node produces; `undefined` = unknown (or the node is missing / in a cycle). */
  fieldsOf(id: string): FieldMap | undefined {
    if (this.memo.has(id)) {
      return this.memo.get(id);
    }
    if (this.visiting.has(id) || !Object.hasOwn(this.nodes, id)) {
      return undefined;
    }
    return this.analyze(id, new Issues());
  }

  /** Field types for `calculate` over a map; `undefined` = the row has no such field. */
  static resolver(known: FieldMap | undefined): (name: string) => FieldType | undefined {
    return (name) => (known === undefined ? "unknown" : known.get(name));
  }

  /** Check one node's field references against the nodes it reads, reporting into `issues`. */
  validateNode(id: string, issues: Issues): void {
    this.analyze(id, issues);
  }

  private analyze(id: string, issues: Issues): FieldMap | undefined {
    this.visiting.add(id);
    const out = this.compute(id, `nodes.${id}`, issues);
    this.visiting.delete(id);
    this.memo.set(id, out);
    return out;
  }

  private compute(id: string, path: string, issues: Issues): FieldMap | undefined {
    const node = this.nodes[id];
    switch (node.kind) {
      case "source":
        return metaFields(this.metas.find((meta) => meta.node === id));
      case "filter": {
        const input = this.fieldsOf(node.from);
        checkCondition(input, node.where, `${path}.where`, issues);
        return input;
      }
      case "columns":
        return this.computeColumns(node, path, issues);
      case "calculate":
        return this.computeCalculate(node, path, issues);
      case "groupBy":
        return this.computeGroupBy(node, path, issues);
      case "sql":
        return this.computeSql(node, path, issues);
      case "join":
        return this.computeJoin(node, path, issues);
      case "stack":
        return this.computeStack(node, path, issues);
      default:
        return undefined;
    }
  }

  private computeColumns(
    node: NodeOf<"columns">,
    path: string,
    issues: Issues,
  ): FieldMap | undefined {
    const input = this.fieldsOf(node.from);
    if (input === undefined) {
      return undefined;
    }
    const edited = editFields(input, node.edits, `${path}.edits`, issues);
    if (node.only === undefined) {
      return edited;
    }
    const out: FieldMap = new Map();
    for (const [i, name] of node.only.entries()) {
      const type = edited.get(name);
      if (type === undefined) {
        issues.add(`${path}.only[${i}]`, `Unknown field "${name}".`);
      } else {
        out.set(name, type);
      }
    }
    return out;
  }

  private computeCalculate(
    node: NodeOf<"calculate">,
    path: string,
    issues: Issues,
  ): FieldMap | undefined {
    const input = this.fieldsOf(node.from);
    const known: FieldMap | undefined = input === undefined ? undefined : new Map(input);
    for (const [i, field] of node.fields.entries()) {
      const result = analyzeExpression(field.expr, GraphScope.resolver(known));
      if (!result.ok) {
        for (const error of result.errors) {
          issues.add(`${path}.fields[${i}].expr`, error.message, error);
        }
      }
      if (known !== undefined) {
        known.set(field.field, result.ok ? result.type : "unknown");
      }
    }
    return known;
  }

  private computeSql(node: NodeOf<"sql">, path: string, issues: Issues): FieldMap | undefined {
    const result = analyzeSqlStep(node.query, [node.from, ...(node.reads ?? [])]);
    if (!result.ok) {
      for (const error of result.errors) {
        issues.add(`${path}.query`, error.message, error);
      }
      return undefined;
    }
    const columns = result.analysis.columns;
    if (columns.includes("d")) {
      return undefined;
    }
    const props = columns.filter((name) => name !== "row_id" && name !== "geom");
    return new Map(props.map((name) => [name, "unknown"]));
  }

  private computeGroupBy(
    node: NodeOf<"groupBy">,
    path: string,
    issues: Issues,
  ): FieldMap | undefined {
    const known = this.fieldsOf(node.from);
    for (const [i, field] of node.by.entries()) {
      checkField(known, field, `${path}.by[${i}]`, issues);
    }
    for (const [i, measure] of node.measures.entries()) {
      for (const ref of [measure.field, measure.by]) {
        if (ref !== undefined) {
          checkField(known, ref, `${path}.measures[${i}]`, issues);
        }
      }
    }
    if (known === undefined) {
      return undefined;
    }
    const next: FieldMap = new Map();
    for (const field of node.by) {
      next.set(field, known.get(field) ?? "unknown");
    }
    for (const measure of node.measures) {
      next.set(measure.as, measureType(measure, known));
    }
    return next;
  }

  private computeJoin(node: JoinNode, path: string, issues: Issues): FieldMap | undefined {
    const left = this.fieldsOf(node.left);
    const right = this.fieldsOf(node.right);
    for (const [i, pair] of node.on.entries()) {
      checkField(left, pair.left, `${path}.on[${i}].left`, issues);
      checkField(right, pair.right, `${path}.on[${i}].right`, issues);
    }
    for (const [i, field] of (node.fields ?? []).entries()) {
      checkField(right, field, `${path}.fields[${i}]`, issues);
    }
    checkMultiMatchRefs(node, right, `${path}.multiMatch`, issues);
    if (left === undefined) {
      return undefined;
    }
    return joinedFields(left, node, right, this.titleOf(node.right));
  }

  /** Stacked rows keep the union of every input's (edited) fields (unknown if any is). */
  private computeStack(node: NodeOf<"stack">, path: string, issues: Issues): FieldMap | undefined {
    let next: FieldMap | undefined = new Map();
    for (const [i, input] of node.inputs.entries()) {
      const raw = this.fieldsOf(input.node);
      const fields =
        raw === undefined
          ? undefined
          : editFields(raw, input.columns, `${path}.inputs[${i}].columns`, issues);
      if (fields === undefined || next === undefined) {
        next = undefined;
        continue;
      }
      for (const [name, type] of fields) {
        next.set(name, next.get(name) ?? type);
      }
    }
    if (next !== undefined && node.tagField !== undefined) {
      next.set(node.tagField, "unknown");
    }
    return next;
  }
}

/** Report `field` when the row is known and lacks it. */
export function checkField(
  known: FieldMap | undefined,
  field: string,
  path: string,
  issues: Issues,
): void {
  if (known !== undefined && !known.has(field)) {
    issues.add(path, `Unknown field "${field}".`);
  }
}

function checkCondition(
  known: FieldMap | undefined,
  cond: Condition,
  path: string,
  issues: Issues,
): void {
  if ("field" in cond) {
    checkField(known, cond.field, `${path}.field`, issues);
  } else if ("not" in cond) {
    checkCondition(known, cond.not, `${path}.not`, issues);
  } else {
    const key = "and" in cond ? "and" : "or";
    const children = "and" in cond ? cond.and : cond.or;
    for (const [i, child] of children.entries()) {
      checkCondition(known, child, `${path}.${key}[${i}]`, issues);
    }
  }
}

/** Names the join adds for the row-copying modes (first / last / error). */
function copiedFields(
  step: JoinNode,
  right: FieldMap | undefined,
  prefix: string,
): [string, FieldType][] | undefined {
  const names = step.fields ?? (right === undefined ? undefined : [...right.keys()]);
  if (names === undefined || right === undefined) {
    return undefined;
  }
  return names.map((name) => [prefixed(prefix, name), right.get(name) ?? "unknown"]);
}

/** The fields (and types) a join adds, or undefined when they cannot be known. */
function addedFields(
  step: JoinNode,
  right: FieldMap | undefined,
  title: string,
): [string, FieldType][] | undefined {
  const { multiMatch } = step;
  const prefix = joinPrefix(step, title);
  switch (multiMatch.mode) {
    case "summarize":
      return multiMatch.measures.map((measure) => [measure.as, measureType(measure, right)]);
    case "spread": {
      const valueType = right === undefined ? undefined : right.get(multiMatch.value);
      return multiMatch.columns.map((column) => [column.as, valueType ?? "unknown"]);
    }
    case "text":
      return [[prefixed(prefix, multiMatch.field), "string"]];
    case "list":
      return [[listKey(prefix, title), "unknown"]];
    default:
      return copiedFields(step, right, prefix);
  }
}

/** The row's fields after a join, or undefined when they cannot be known. */
function joinedFields(
  before: FieldMap,
  step: JoinNode,
  right: FieldMap | undefined,
  title: string,
): FieldMap | undefined {
  const added = addedFields(step, right, title);
  return added === undefined ? undefined : new Map([...before, ...added]);
}

function checkRight(
  right: FieldMap | undefined,
  field: string,
  path: string,
  issues: Issues,
): void {
  if (right !== undefined && !right.has(field)) {
    issues.add(path, `Unknown field "${field}".`);
  }
}

function checkMeasureRefs(
  measures: Measure[],
  right: FieldMap | undefined,
  path: string,
  issues: Issues,
): void {
  for (const [i, measure] of measures.entries()) {
    for (const ref of [measure.field, measure.by]) {
      if (ref !== undefined) {
        checkRight(right, ref, `${path}.measures[${i}]`, issues);
      }
    }
  }
}

function checkMultiMatchRefs(
  step: JoinNode,
  right: FieldMap | undefined,
  path: string,
  issues: Issues,
): void {
  const { multiMatch } = step;
  switch (multiMatch.mode) {
    case "summarize":
      checkMeasureRefs(multiMatch.measures, right, path, issues);
      break;
    case "spread":
      checkRight(right, multiMatch.by, `${path}.by`, issues);
      checkRight(right, multiMatch.value, `${path}.value`, issues);
      break;
    case "text":
      checkRight(right, multiMatch.field, `${path}.field`, issues);
      break;
    case "first":
    case "last":
      for (const [i, sort] of (multiMatch.orderBy ?? []).entries()) {
        checkRight(right, sort.field, `${path}.orderBy[${i}]`, issues);
      }
      break;
    default:
      break;
  }
}

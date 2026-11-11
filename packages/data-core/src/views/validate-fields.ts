/**
 * Field-reference checking: walks the step list tracking which field names
 * (and their types) exist in the current row. Skipped (never an error) once
 * the row's shape is unknown, i.e. when the base input has no `fields`
 * metadata or after a `sql` step whose output is a bare `d`. The compiler
 * reuses the same walk to learn field types for `calculate`.
 */

import { analyzeExpression } from "./calculate.js";
import { joinPrefix, listKey, prefixed } from "./join-names.js";
import { analyzeSqlStep } from "./sql-step.js";
import type { CompileInputMeta, Condition, FieldType, JoinStep, Measure, Step } from "./types.js";
import { isRecord } from "./validate-issues.js";
import type { Issues } from "./validate-issues.js";
import { validateStepShape } from "./validate-steps.js";

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

export class FieldScope {
  private known: FieldMap | undefined;

  constructor(
    base: string,
    private readonly metas: CompileInputMeta[],
    private readonly aliases: Set<string>,
  ) {
    this.known = metaFields(metas.find((meta) => meta.alias === base));
  }

  /** Field types for `calculate`; `undefined` = the row has no such field. */
  resolver(): (name: string) => FieldType | undefined {
    const known = this.known;
    return (name) => (known === undefined ? "unknown" : known.get(name));
  }

  /** Report `field` when the current row is known and lacks it. */
  check(field: string, path: string, issues: Issues): void {
    if (this.known !== undefined && !this.known.has(field)) {
      issues.add(path, `Unknown field "${field}".`);
    }
  }

  /** Shape-check and apply every step of a (sub-)pipeline. */
  validateList(steps: unknown[], path: string, issues: Issues): void {
    for (const [i, raw] of steps.entries()) {
      const at = `${path}[${i}]`;
      if (!isRecord(raw) || typeof raw.kind !== "string") {
        issues.add(at, "Each step needs a kind.");
        continue;
      }
      const before = issues.count;
      validateStepShape(raw, at, this.aliases, issues);
      // Only walk the field scope through well-formed steps.
      if (issues.count === before && isStep(raw)) {
        this.apply(raw, at, issues);
      }
    }
  }

  apply(step: Step, path: string, issues: Issues): void {
    switch (step.kind) {
      case "filter":
        this.checkCondition(step.where, `${path}.where`, issues);
        break;
      case "join":
        this.applyJoin(step, path, issues);
        break;
      case "groupBy":
        this.applyGroupBy(step, path, issues);
        break;
      case "select":
        this.applySelect(step, path, issues);
        break;
      case "calculate":
        this.applyCalculate(step, path, issues);
        break;
      case "sql":
        this.applySql(step, path, issues);
        break;
      default:
        this.known = undefined;
    }
  }

  private applyCalculate(
    step: Extract<Step, { kind: "calculate" }>,
    path: string,
    issues: Issues,
  ): void {
    const result = analyzeExpression(step.expr, this.resolver());
    if (!result.ok) {
      for (const error of result.errors) {
        issues.add(`${path}.expr`, error.message, error);
      }
    }
    if (this.known !== undefined) {
      this.known.set(step.field, result.ok ? result.type : "unknown");
    }
  }

  private applySql(step: Extract<Step, { kind: "sql" }>, path: string, issues: Issues): void {
    const result = analyzeSqlStep(step.query, [...this.aliases]);
    if (!result.ok) {
      for (const error of result.errors) {
        issues.add(`${path}.query`, error.message, error);
      }
      this.known = undefined;
      return;
    }
    const columns = result.analysis.columns;
    if (columns.includes("d")) {
      this.known = undefined;
      return;
    }
    const props = columns.filter((name) => name !== "row_id" && name !== "geom");
    this.known = new Map(props.map((name) => [name, "unknown"]));
  }

  private checkCondition(cond: Condition, path: string, issues: Issues): void {
    if ("field" in cond) {
      this.check(cond.field, `${path}.field`, issues);
    } else if ("not" in cond) {
      this.checkCondition(cond.not, `${path}.not`, issues);
    } else {
      const key = "and" in cond ? "and" : "or";
      const children = "and" in cond ? cond.and : cond.or;
      for (const [i, child] of children.entries()) {
        this.checkCondition(child, `${path}.${key}[${i}]`, issues);
      }
    }
  }

  private applyGroupBy(
    step: Extract<Step, { kind: "groupBy" }>,
    path: string,
    issues: Issues,
  ): void {
    for (const [i, field] of step.by.entries()) {
      this.check(field, `${path}.by[${i}]`, issues);
    }
    for (const [i, measure] of step.measures.entries()) {
      for (const ref of [measure.field, measure.by]) {
        if (ref !== undefined) {
          this.check(ref, `${path}.measures[${i}]`, issues);
        }
      }
    }
    const known = this.known;
    if (known !== undefined) {
      const next: FieldMap = new Map();
      for (const field of step.by) {
        next.set(field, known.get(field) ?? "unknown");
      }
      for (const measure of step.measures) {
        next.set(measure.as, measureType(measure, known));
      }
      this.known = next;
    }
  }

  private applySelect(step: Extract<Step, { kind: "select" }>, path: string, issues: Issues): void {
    for (const [i, field] of step.fields.entries()) {
      this.check(field.from, `${path}.fields[${i}].from`, issues);
    }
    const known = this.known;
    if (known !== undefined) {
      this.known = new Map(
        step.fields.map((field) => [field.as, known.get(field.from) ?? "unknown"]),
      );
    }
  }

  /** The fields (and types) of a join's right side: the input, then its sub-pipeline. */
  private rightScope(step: JoinStep, path: string, issues: Issues): FieldScope {
    const scope = new FieldScope(step.right.input, this.metas, this.aliases);
    if (Array.isArray(step.right.steps)) {
      scope.validateList(step.right.steps, `${path}.right.steps`, issues);
    }
    return scope;
  }

  private applyJoin(step: JoinStep, path: string, issues: Issues): void {
    const rightMeta = this.metas.find((meta) => meta.alias === step.right.input);
    const right = this.rightScope(step, path, issues).known;
    for (const [i, pair] of step.on.entries()) {
      this.check(pair.left, `${path}.on[${i}].left`, issues);
      checkRight(right, pair.right, `${path}.on[${i}].right`, issues);
    }
    for (const [i, field] of (step.fields ?? []).entries()) {
      checkRight(right, field, `${path}.fields[${i}]`, issues);
    }
    checkMultiMatchRefs(step, right, `${path}.multiMatch`, issues);
    if (this.known !== undefined) {
      this.known = joinedFields(this.known, step, right, rightMeta);
    }
  }
}

/** Narrowing after validateStepShape found no problems with the step. */
function isStep(raw: Record<string, unknown>): raw is Record<string, unknown> & Step {
  return typeof raw.kind === "string";
}

/** Names the join adds for the row-copying modes (first / last / error). */
function copiedFields(
  step: JoinStep,
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
  step: JoinStep,
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
  step: JoinStep,
  right: FieldMap | undefined,
  rightMeta: CompileInputMeta | undefined,
): FieldMap | undefined {
  const added = addedFields(step, right, rightMeta === undefined ? "" : rightMeta.title);
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
  step: JoinStep,
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

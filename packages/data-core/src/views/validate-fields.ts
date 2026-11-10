/**
 * Field-reference checking: walks the step list tracking which field names
 * exist in the current row. Skipped (never an error) once the row's shape is
 * unknown, i.e. when the base input has no `fields` metadata or after a
 * `sql` step.
 */

import { slugify } from "./sql-util.js";
import type { CompileInputMeta, Condition, JoinStep, Step } from "./types.js";
import type { Issues } from "./validate-issues.js";

function fieldNames(meta: CompileInputMeta | undefined): string[] | undefined {
  return meta === undefined || meta.fields === undefined
    ? undefined
    : meta.fields.map((field) => field.name);
}

export class FieldScope {
  private known: Set<string> | undefined;

  constructor(base: string, metas: CompileInputMeta[]) {
    const names = fieldNames(metas.find((meta) => meta.alias === base));
    this.known = names === undefined ? undefined : new Set(names);
  }

  /** Report `field` when the current row is known and lacks it. */
  check(field: string, path: string, issues: Issues): void {
    if (this.known !== undefined && !this.known.has(field)) {
      issues.add(path, `Unknown field "${field}".`);
    }
  }

  apply(step: Step, path: string, metas: CompileInputMeta[], issues: Issues): void {
    switch (step.kind) {
      case "filter":
        this.checkCondition(step.where, `${path}.where`, issues);
        break;
      case "join":
        this.applyJoin(step, path, metas, issues);
        break;
      case "groupBy":
        this.applyGroupBy(step, path, issues);
        break;
      case "select":
        this.applySelect(step, path, issues);
        break;
      case "calculate":
        if (this.known !== undefined) {
          this.known.add(step.field);
        }
        break;
      default:
        this.known = undefined;
    }
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
    if (this.known !== undefined) {
      this.known = new Set([...step.by, ...step.measures.map((measure) => measure.as)]);
    }
  }

  private applySelect(step: Extract<Step, { kind: "select" }>, path: string, issues: Issues): void {
    for (const [i, field] of step.fields.entries()) {
      this.check(field.from, `${path}.fields[${i}].from`, issues);
    }
    if (this.known !== undefined) {
      this.known = new Set(step.fields.map((field) => field.as));
    }
  }

  private applyJoin(step: JoinStep, path: string, metas: CompileInputMeta[], issues: Issues): void {
    const rightMeta = metas.find((meta) => meta.alias === step.right.input);
    const rightFields = fieldNames(rightMeta);
    for (const [i, pair] of step.on.entries()) {
      this.check(pair.left, `${path}.on[${i}].left`, issues);
      checkRight(rightFields, pair.right, `${path}.on[${i}].right`, issues);
    }
    for (const [i, field] of (step.fields ?? []).entries()) {
      checkRight(rightFields, field, `${path}.fields[${i}]`, issues);
    }
    checkMultiMatchRefs(step, rightFields, `${path}.multiMatch`, issues);
    if (this.known !== undefined) {
      this.addJoinedFields(step, rightFields, rightMeta);
    }
  }

  private addJoinedFields(
    step: JoinStep,
    rightFields: string[] | undefined,
    rightMeta: CompileInputMeta | undefined,
  ): void {
    const known = this.known;
    const { multiMatch } = step;
    if (known === undefined) {
      return;
    }
    if (multiMatch.mode === "summarize") {
      addAll(
        known,
        multiMatch.measures.map((measure) => measure.as),
      );
    } else if (multiMatch.mode === "spread") {
      addAll(
        known,
        multiMatch.columns.map((column) => column.as),
      );
    } else if (multiMatch.mode === "first" || multiMatch.mode === "last") {
      const names = step.fields ?? rightFields;
      const prefix = step.prefix ?? slugify(rightMeta === undefined ? "" : rightMeta.title);
      if (names === undefined) {
        this.known = undefined;
      } else {
        addAll(
          known,
          names.map((name) => (prefix === "" ? name : `${prefix}.${name}`)),
        );
      }
    } else {
      this.known = undefined;
    }
  }
}

function addAll(target: Set<string>, names: string[]): void {
  for (const name of names) {
    target.add(name);
  }
}

function checkRight(
  rightFields: string[] | undefined,
  field: string,
  path: string,
  issues: Issues,
): void {
  if (rightFields !== undefined && !rightFields.includes(field)) {
    issues.add(path, `Unknown field "${field}".`);
  }
}

function checkMultiMatchRefs(
  step: JoinStep,
  rightFields: string[] | undefined,
  path: string,
  issues: Issues,
): void {
  const { multiMatch } = step;
  if (multiMatch.mode === "summarize") {
    for (const [i, measure] of multiMatch.measures.entries()) {
      for (const ref of [measure.field, measure.by]) {
        if (ref !== undefined) {
          checkRight(rightFields, ref, `${path}.measures[${i}]`, issues);
        }
      }
    }
  } else if (multiMatch.mode === "spread") {
    checkRight(rightFields, multiMatch.by, `${path}.by`, issues);
    checkRight(rightFields, multiMatch.value, `${path}.value`, issues);
  } else if (multiMatch.mode === "first" || multiMatch.mode === "last") {
    for (const [i, sort] of (multiMatch.orderBy ?? []).entries()) {
      checkRight(rightFields, sort.field, `${path}.orderBy[${i}]`, issues);
    }
  }
}

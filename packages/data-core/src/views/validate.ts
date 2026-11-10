/**
 * Structural and semantic validation of a ViewDefinition (plain TypeScript:
 * this package carries no schema-library dependency). Returns every problem
 * with a JSON-path-style location. Field references are checked against the
 * input schemas only when `inputs[].fields` metadata is supplied.
 */

import { containsUuid } from "./sql-util.js";
import type { CompileInputMeta, Step, ValidationResult, ViewDefinition } from "./types.js";
import { FieldScope } from "./validate-fields.js";
import { Issues, isRecord } from "./validate-issues.js";
import { validateStepShape } from "./validate-steps.js";

const ALIAS_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

function validateInputs(raw: Record<string, unknown>, issues: Issues): Set<string> {
  const aliases = new Set<string>();
  const inputs = raw.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    issues.add("inputs", "At least one input is required.");
    return aliases;
  }
  for (const [i, input] of inputs.entries()) {
    const path = `inputs[${i}]`;
    if (!isRecord(input) || typeof input.alias !== "string") {
      issues.add(path, "Each input needs an alias and a dataset ref.");
      continue;
    }
    validateAlias(input.alias, `${path}.alias`, aliases, issues);
    aliases.add(input.alias);
    validateRef(input.ref, `${path}.ref`, issues);
  }
  return aliases;
}

function validateAlias(alias: string, path: string, seen: Set<string>, issues: Issues): void {
  if (!ALIAS_PATTERN.test(alias)) {
    issues.add(path, "Aliases use 1-40 letters, digits or underscores.");
  } else if (containsUuid(alias)) {
    issues.add(path, "Aliases must be readable names, never dataset ids.");
  }
  if (seen.has(alias)) {
    issues.add(path, `Duplicate input alias "${alias}".`);
  }
}

function validateRef(ref: unknown, path: string, issues: Issues): void {
  if (!isRecord(ref) || ref.kind !== "dataset" || typeof ref.id !== "string" || ref.id === "") {
    issues.add(path, 'Input ref must be { kind: "dataset", id }.');
    return;
  }
  if (ref.version !== undefined && typeof ref.version !== "string") {
    issues.add(`${path}.version`, "Version must be a string.");
  }
}

function validateOutput(output: unknown, scope: FieldScope, issues: Issues): void {
  if (!isRecord(output) || !Array.isArray(output.fields)) {
    issues.add("output", "Output needs a fields array and an emptyFields mode.");
    return;
  }
  if (output.emptyFields !== "keep" && output.emptyFields !== "omit") {
    issues.add("output.emptyFields", 'Must be "keep" or "omit".');
  }
  const seen = new Set<string>();
  for (const [i, field] of output.fields.entries()) {
    const path = `output.fields[${i}]`;
    if (!isRecord(field) || typeof field.key !== "string" || field.key === "") {
      issues.add(path, "Each output field needs a key.");
      continue;
    }
    if (seen.has(field.key)) {
      issues.add(`${path}.key`, `Duplicate output key "${field.key}".`);
    }
    seen.add(field.key);
    scope.check(field.key, `${path}.key`, issues);
  }
}

/** Narrowing after validateStepShape found no problems with the step. */
function isStep(raw: Record<string, unknown>): raw is Record<string, unknown> & Step {
  return typeof raw.kind === "string";
}

/** Narrowing after every shape check passed. */
function isDefinition(
  def: Record<string, unknown>,
): def is Record<string, unknown> & ViewDefinition {
  return Array.isArray(def.inputs) && Array.isArray(def.steps) && typeof def.base === "string";
}

function validateSteps(
  steps: unknown[],
  aliases: Set<string>,
  scope: FieldScope,
  metas: CompileInputMeta[],
  issues: Issues,
): void {
  for (const [i, raw] of steps.entries()) {
    const path = `steps[${i}]`;
    if (!isRecord(raw) || typeof raw.kind !== "string") {
      issues.add(path, "Each step needs a kind.");
      continue;
    }
    const before = issues.count;
    validateStepShape(raw, path, aliases, issues);
    if (issues.count === before) {
      // Only walk the field scope through well-formed steps.
      if (isStep(raw)) {
        scope.apply(raw, path, metas, issues);
      }
    }
  }
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
  const aliases = validateInputs(def, issues);
  const base = def.base;
  if (typeof base !== "string" || !aliases.has(base)) {
    issues.add("base", "base must be the alias of one of the inputs.");
  }
  const metas = inputs ?? [];
  const scope = new FieldScope(typeof base === "string" ? base : "", metas);
  if (Array.isArray(def.steps)) {
    validateSteps(def.steps, aliases, scope, metas, issues);
  } else {
    issues.add("steps", "steps must be an array.");
  }
  validateOutput(def.output, scope, issues);
  if (issues.count > 0) {
    return { ok: false, errors: issues.list };
  }
  return isDefinition(def) ? { ok: true, value: def } : { ok: false, errors: issues.list };
}

/**
 * Reuse without templates (ADR 0028 §7): pure helpers behind Duplicate,
 * input remap and Extract to view. No I/O; the app wires them to the store.
 */
import { joinPrefix } from "./join-names.js";
import { slugify } from "./sql-util.js";
import type {
  CompileInputMeta,
  JoinStep,
  RightSide,
  Step,
  ValidationError,
  ViewDefinition,
  ViewInput,
} from "./types.js";
import { validateViewDefinition } from "./validate.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Join modes whose output names are built from the join prefix. */
function usesPrefix(step: JoinStep): boolean {
  return step.multiMatch.mode !== "summarize" && step.multiMatch.mode !== "spread";
}

// ---------------------------------------------------------------------------
// Input aliases
// ---------------------------------------------------------------------------

function collectAliases(steps: readonly Step[], used: Set<string>): void {
  for (const step of steps) {
    if (step.kind === "join") {
      used.add(step.right.input);
      collectAliases(step.right.steps ?? [], used);
    } else if (step.kind === "sql") {
      for (const match of step.query.matchAll(/\bin_([A-Za-z0-9_]+)/g)) {
        used.add(match[1] ?? "");
      }
    }
  }
}

/** Drops inputs no step reads (never the base). Sub-pipelines and SQL `in_<alias>` reads count. */
export function pruneInputs(definition: ViewDefinition): ViewDefinition {
  const used = new Set<string>([definition.base]);
  collectAliases(definition.steps, used);
  return { ...definition, inputs: definition.inputs.filter((input) => used.has(input.alias)) };
}

/** An input alias not in `taken`, derived from a title (letters, digits, underscores). */
export function freshAlias(title: string, taken: readonly string[]): string {
  const base = slugify(title);
  if (!taken.includes(base)) {
    return base;
  }
  let n = 2;
  while (taken.includes(`${base}_${n}`)) {
    n += 1;
  }
  return `${base}_${n}`;
}

// ---------------------------------------------------------------------------
// Duplicate and remap
// ---------------------------------------------------------------------------

/** "<title> (copy)". */
export function copyTitle(title: string): string {
  return `${title} (copy)`;
}

/** A deep copy of the definition: steps, inputs and the output schema with its labels. */
export function duplicateDefinition(definition: ViewDefinition): ViewDefinition {
  return clone(definition);
}

export interface InputRemap {
  /** Which declared input (by alias) is re-pointed. */
  alias: string;
  /** The dataset or view it reads instead. */
  datasetId: string;
  /** The title the input had before (so default join prefixes keep their names). */
  oldTitle: string;
}

function pinPrefixes(steps: Step[], oldTitles: Map<string, string>): Step[] {
  return steps.map((step) => {
    if (step.kind !== "join") {
      return step;
    }
    const oldTitle = oldTitles.get(step.right.input);
    const right: RightSide =
      step.right.steps === undefined
        ? step.right
        : { ...step.right, steps: pinPrefixes(step.right.steps, oldTitles) };
    const pinned =
      oldTitle !== undefined && step.prefix === undefined && usesPrefix(step)
        ? { prefix: joinPrefix(step, oldTitle) }
        : {};
    return { ...step, ...pinned, right };
  });
}

/**
 * The definition with some inputs re-pointed at other datasets/views. Aliases
 * stay (steps refer to them). A pinned version belongs to the old dataset and
 * is dropped. A join whose right input moves keeps its output names: the
 * default prefix (a slug of the old title) is written down explicitly.
 */
export function remapInputs(
  definition: ViewDefinition,
  remaps: readonly InputRemap[],
): ViewDefinition {
  const changed = remaps.filter((remap) => {
    const input = definition.inputs.find((entry) => entry.alias === remap.alias);
    return input !== undefined && input.ref.id !== remap.datasetId;
  });
  if (changed.length === 0) {
    return clone(definition);
  }
  const byAlias = new Map(changed.map((remap) => [remap.alias, remap]));
  const inputs: ViewInput[] = definition.inputs.map((input) => {
    const remap = byAlias.get(input.alias);
    return remap === undefined
      ? clone(input)
      : { alias: input.alias, ref: { kind: "dataset", id: remap.datasetId } };
  });
  const oldTitles = new Map(changed.map((remap) => [remap.alias, remap.oldTitle]));
  return {
    ...clone(definition),
    inputs,
    steps: pinPrefixes(clone(definition.steps), oldTitles),
  };
}

/** Where a validation error is, in the editor's words ("Step 2", "Step 1, sub-step 3", "Output"). */
export function stepLabelOfPath(path: string): string {
  const match = /^steps\[(\d+)\]/.exec(path);
  if (match === null) {
    return path.startsWith("output") ? "Output" : "Definition";
  }
  const subs = [...path.matchAll(/\.right\.steps\[(\d+)\]/g)].map((m) => Number(m[1]) + 1);
  const head = `Step ${Number(match[1]) + 1}`;
  return subs.length === 0 ? head : `${head}, sub-step ${subs.join(".")}`;
}

export interface RemapProblem {
  /** "Step 2", "Step 1, sub-step 1", "Output". */
  step: string;
  path: string;
  message: string;
}

export type RemapReport =
  | { ok: true; definition: ViewDefinition }
  | { ok: false; problems: RemapProblem[]; byStep: { step: string; messages: string[] }[] };

function problemOf(error: ValidationError): RemapProblem {
  return { step: stepLabelOfPath(error.path), path: error.path, message: error.message };
}

/**
 * Validates a (remapped) definition with the REAL validator against the new
 * inputs' fields, and groups the problems per step ("Step 2: no field
 * `stateId`"), so the dialog can show what to fix before anything is created.
 */
export function remapReport(
  definition: ViewDefinition,
  metas: readonly CompileInputMeta[],
): RemapReport {
  const result = validateViewDefinition(definition, [...metas]);
  if (result.ok) {
    return { ok: true, definition: result.value };
  }
  const problems = result.errors.map((error) => problemOf(error));
  const byStep: { step: string; messages: string[] }[] = [];
  for (const problem of problems) {
    const group = byStep.find((entry) => entry.step === problem.step);
    if (group === undefined) {
      byStep.push({ step: problem.step, messages: [problem.message] });
    } else if (!group.messages.includes(problem.message)) {
      group.messages.push(problem.message);
    }
  }
  return { ok: false, problems, byStep };
}

// ---------------------------------------------------------------------------
// Extract to view
// ---------------------------------------------------------------------------

/**
 * Which join: indices alternating down the nesting. `[1]` is `steps[1]`;
 * `[1, 0]` is the join at `steps[1].right.steps[0]`.
 */
export type JoinPath = readonly number[];

function stepsAt(definition: ViewDefinition, path: JoinPath): Step[] | undefined {
  let steps: Step[] | undefined = definition.steps;
  for (const index of path.slice(0, -1)) {
    const step: Step | undefined = steps === undefined ? undefined : steps[index];
    steps = step !== undefined && step.kind === "join" ? step.right.steps : undefined;
  }
  return steps;
}

/** The join at `path`, when there is one. */
export function joinAt(definition: ViewDefinition, path: JoinPath): JoinStep | undefined {
  const steps = stepsAt(definition, path);
  const last = path.at(-1);
  const step = steps === undefined || last === undefined ? undefined : steps[last];
  return step !== undefined && step.kind === "join" ? step : undefined;
}

/** Whether "Extract to view" applies: a join with an inline sub-pipeline of at least one step. */
export function canExtract(definition: ViewDefinition, path: JoinPath): boolean {
  const join = joinAt(definition, path);
  return join !== undefined && join.right.steps !== undefined && join.right.steps.length > 0;
}

function replaceJoin(steps: Step[], path: JoinPath, replace: (join: JoinStep) => JoinStep): Step[] {
  const [head, ...rest] = path;
  return steps.map((step, i) => {
    if (i !== head || step.kind !== "join") {
      return step;
    }
    if (rest.length === 0) {
      return replace(step);
    }
    return {
      ...step,
      right: { ...step.right, steps: replaceJoin(step.right.steps ?? [], rest, replace) },
    };
  });
}

export interface ExtractPlan {
  /** The definition of the new view: base = the join's right input, steps = the sub-pipeline, output = every field. */
  view: ViewDefinition;
  /** The prefix the rewritten join keeps (so its output names do not change with the new input's title). */
  keepPrefix: string | undefined;
}

export type ExtractResult = { ok: true; plan: ExtractPlan } | { ok: false; reason: string };

/**
 * The new view for "Extract to view" on the join at `path`. `rightTitle` is
 * the title of the join's current right input (it names the default prefix).
 */
export function planExtract(
  definition: ViewDefinition,
  path: JoinPath,
  rightTitle: string,
): ExtractResult {
  const join = joinAt(definition, path);
  if (join === undefined) {
    return { ok: false, reason: "That step is not a join." };
  }
  if (join.right.steps === undefined || join.right.steps.length === 0) {
    return { ok: false, reason: "This join's input has no steps to extract." };
  }
  const view = pruneInputs({
    inputs: clone(definition.inputs),
    base: join.right.input,
    steps: clone(join.right.steps),
    output: { fields: [], emptyFields: "keep" },
  });
  return {
    ok: true,
    plan: {
      view,
      keepPrefix:
        usesPrefix(join) && join.prefix === undefined ? joinPrefix(join, rightTitle) : undefined,
    },
  };
}

/**
 * The edited definition once the new view exists: the join reads the view
 * (declared as a new input) with no steps of its own, and keeps its prefix.
 * Unused inputs are pruned.
 */
export function applyExtract(
  definition: ViewDefinition,
  path: JoinPath,
  plan: ExtractPlan,
  created: { id: string; title: string },
): ViewDefinition {
  const alias = freshAlias(
    created.title,
    definition.inputs.map((input) => input.alias),
  );
  const steps = replaceJoin(clone(definition.steps), path, (join) => ({
    ...join,
    right: { input: alias },
    ...(plan.keepPrefix === undefined ? {} : { prefix: plan.keepPrefix }),
  }));
  return pruneInputs({
    ...clone(definition),
    inputs: [...clone(definition.inputs), { alias, ref: { kind: "dataset", id: created.id } }],
    steps,
  });
}

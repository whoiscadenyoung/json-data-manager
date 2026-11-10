import { compileCondition } from "./condition.js";
import { ViewCompileError, ViewStepNotSupportedError } from "./errors.js";
import { getInput, inputCte, resolveInputs } from "./inputs.js";
import type { ResolvedInput } from "./inputs.js";
import { compileJoin } from "./join.js";
import type { JoinInfo } from "./join.js";
import { measureExpr } from "./measures.js";
import { buildObject, fieldJson, ParamBag, quoteIdent } from "./sql-util.js";
import type { CompileInputMeta, Step, StepKind, ViewDefinition } from "./types.js";

export interface StepInfo {
  index: number;
  kind: StepKind;
  /** Quoted CTE name feeding the step. */
  input: string;
  /** Quoted CTE name the step produced. */
  output: string;
  join?: JoinInfo;
}

export interface Chain {
  ctes: string[];
  steps: StepInfo[];
  /** Quoted name of the CTE holding the last step's rows (or the base input). */
  last: string;
  bag: ParamBag;
  /** True when every step of the definition was compiled (output schema applies). */
  complete: boolean;
}

export interface ChainOptions {
  uptoStep?: number;
  unaccent?: boolean;
}

function stepCount(def: ViewDefinition, uptoStep: number | undefined): number {
  if (uptoStep === undefined) {
    return def.steps.length;
  }
  if (!Number.isInteger(uptoStep) || uptoStep < 0) {
    throw new ViewCompileError("uptoStep must be a non-negative integer.");
  }
  return Math.min(def.steps.length, uptoStep + 1);
}

function compileFilter(
  step: Extract<Step, { kind: "filter" }>,
  prev: string,
  out: string,
  bag: ParamBag,
): string {
  return `${out} as (
  select row_id, d, geom
  from ${prev}
  where ${compileCondition(step.where, "d", bag)}
)`;
}

function compileSelect(
  step: Extract<Step, { kind: "select" }>,
  prev: string,
  out: string,
  bag: ParamBag,
): string {
  const pairs = step.fields.map((field) => ({
    key: field.as,
    value: fieldJson("d", bag, field.from),
  }));
  return `${out} as (
  select row_id, ${buildObject(pairs, bag)} as d, geom
  from ${prev}
)`;
}

function compileGroupBy(
  step: Extract<Step, { kind: "groupBy" }>,
  prev: string,
  out: string,
  bag: ParamBag,
): string {
  if (step.by.length === 0) {
    throw new ViewCompileError("groupBy needs at least one field in `by`.");
  }
  const keys = step.by.map((field, i) => `${fieldJson("d", bag, field)} as g${i}`);
  const groupCols = step.by.map((_, i) => `g${i}`);
  const keyPairs = step.by.map((field, i) => ({ key: field, value: `g${i}` }));
  const measurePairs = step.measures.map((measure) => ({
    key: measure.as,
    value: measureExpr(measure, "d", bag, "groupBy"),
  }));
  const object = buildObject([...keyPairs, ...measurePairs], bag);
  const identity = `md5(jsonb_build_array(${groupCols.join(", ")})::text)::uuid`;
  return `${out} as (
  select ${identity} as row_id, ${object} as d, null::geometry(Geometry,4326) as geom
  from (select d, ${keys.join(", ")} from ${prev}) t
  group by ${groupCols.join(", ")}
)`;
}

interface StepContext {
  inputs: Map<string, ResolvedInput>;
  bag: ParamBag;
  unaccent: boolean;
}

function compileStep(
  step: Step,
  index: number,
  prev: string,
  ctx: StepContext,
): { ctes: string[]; info: StepInfo } {
  const out = quoteIdent(`s${index}`);
  const info: StepInfo = { index, kind: step.kind, input: prev, output: out };
  switch (step.kind) {
    case "filter":
      return { ctes: [compileFilter(step, prev, out, ctx.bag)], info };
    case "select":
      return { ctes: [compileSelect(step, prev, out, ctx.bag)], info };
    case "groupBy":
      return { ctes: [compileGroupBy(step, prev, out, ctx.bag)], info };
    case "join": {
      const joined = compileJoin(step, index, prev, ctx);
      return { ctes: joined.ctes, info: { ...info, output: joined.out, join: joined.info } };
    }
    default:
      throw new ViewStepNotSupportedError(step.kind);
  }
}

/** Aliases (base first) whose input CTEs the compiled steps read. */
function usedAliases(def: ViewDefinition, count: number): string[] {
  const aliases = [def.base];
  for (const step of def.steps.slice(0, count)) {
    if (step.kind === "join" && !aliases.includes(step.right.input)) {
      aliases.push(step.right.input);
    }
  }
  return aliases;
}

/** Build the input CTEs and one CTE group per step. Shared by rows and diagnostics. */
export function buildChain(
  def: ViewDefinition,
  metas: CompileInputMeta[],
  options: ChainOptions,
): Chain {
  const inputs = resolveInputs(def, metas);
  const bag = new ParamBag();
  const count = stepCount(def, options.uptoStep);
  const ctes = usedAliases(def, count).map((alias) => inputCte(getInput(inputs, alias), bag));
  const ctx: StepContext = { inputs, bag, unaccent: options.unaccent ?? false };
  const steps: StepInfo[] = [];
  let last = getInput(inputs, def.base).cte;
  for (const [index, step] of def.steps.slice(0, count).entries()) {
    const compiled = compileStep(step, index, last, ctx);
    ctes.push(...compiled.ctes);
    steps.push(compiled.info);
    last = compiled.info.output;
  }
  return { ctes, steps, last, bag, complete: count === def.steps.length };
}

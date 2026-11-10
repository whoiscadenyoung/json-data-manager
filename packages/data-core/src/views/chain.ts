import { compileCalculate } from "./calculate.js";
import { compileCondition } from "./condition.js";
import { ViewCompileError } from "./errors.js";
import { getInput, inputCte, resolveInputs } from "./inputs.js";
import type { ResolvedInput } from "./inputs.js";
import { compileJoin } from "./join.js";
import type { JoinContext, StepInfo, SubChain } from "./join.js";
import { measureExpr } from "./measures.js";
import { compileSqlStep, requireSqlAnalysis } from "./sql-compile.js";
import { buildObject, fieldJson, ParamBag, quoteIdent } from "./sql-util.js";
import type { CompileInputMeta, Step, ViewDefinition } from "./types.js";
import { FieldScope } from "./validate-fields.js";
import { Issues } from "./validate-issues.js";

export type { StepInfo } from "./join.js";

export interface Chain {
  ctes: string[];
  /** Every compiled step in execution order (sub-pipeline steps before their join). */
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
  /** False for diagnostics: the `error` multi-match guard must not abort the query. */
  guards?: boolean;
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

interface ChainContext {
  inputs: Map<string, ResolvedInput>;
  bag: ParamBag;
  unaccent: boolean;
  guards: boolean;
  metas: CompileInputMeta[];
  aliases: Set<string>;
}

interface Naming {
  /** CTE name prefix: empty at the top level, `s<n>_` inside step n's sub-pipeline. */
  prefix: string;
  /** Path of the step list, e.g. `steps` or `steps[1].right.steps`. */
  path: string;
}

function unknownStep(step: never): never {
  throw new ViewCompileError(`Unknown step kind ${JSON.stringify(step)}.`);
}

function compileStep(
  step: Step,
  index: number,
  prev: string,
  ctx: ChainContext,
  scope: FieldScope,
  naming: Naming,
): { ctes: string[]; infos: StepInfo[] } {
  const name = quoteIdent(`${naming.prefix}s${index}`);
  const at = `${naming.path}[${index}]`;
  const base: StepInfo = { index, kind: step.kind, input: prev, output: name };
  if (naming.prefix !== "") {
    base.path = at;
  }
  switch (step.kind) {
    case "filter":
      return { ctes: [compileFilter(step, prev, name, ctx.bag)], infos: [base] };
    case "select":
      return { ctes: [compileSelect(step, prev, name, ctx.bag)], infos: [base] };
    case "groupBy":
      return { ctes: [compileGroupBy(step, prev, name, ctx.bag)], infos: [base] };
    case "calculate":
      return {
        ctes: [compileCalculate(step, prev, name, ctx.bag, scope.resolver())],
        infos: [base],
      };
    case "sql": {
      const analysis = requireSqlAnalysis(step.query, [...ctx.aliases]);
      const raw = quoteIdent(`${naming.prefix}s${index}_q`);
      return { ctes: compileSqlStep(analysis, prev, name, raw, ctx.bag), infos: [base] };
    }
    case "join": {
      const joinCtx: JoinContext = {
        inputs: ctx.inputs,
        bag: ctx.bag,
        unaccent: ctx.unaccent,
        guards: ctx.guards,
        prefix: naming.prefix,
        path: at,
        compileSub: (alias, steps, prefix, path) =>
          compileSteps(
            steps,
            getInput(ctx.inputs, alias).cte,
            ctx,
            new FieldScope(alias, ctx.metas, ctx.aliases),
            { prefix, path },
          ),
      };
      const joined = compileJoin(step, index, prev, joinCtx);
      return {
        ctes: joined.ctes,
        infos: [...joined.subSteps, { ...base, output: joined.out, join: joined.info }],
      };
    }
    default:
      return unknownStep(step);
  }
}

/** Compile a step list into CTEs over `start`. Used for the top level and for sub-pipelines. */
function compileSteps(
  steps: Step[],
  start: string,
  ctx: ChainContext,
  scope: FieldScope,
  naming: Naming,
): SubChain {
  const ctes: string[] = [];
  const infos: StepInfo[] = [];
  const scratch = new Issues();
  let last = start;
  for (const [index, step] of steps.entries()) {
    const compiled = compileStep(step, index, last, ctx, scope, naming);
    ctes.push(...compiled.ctes);
    infos.push(...compiled.infos);
    last = compiled.infos[compiled.infos.length - 1].output;
    scope.apply(step, `${naming.path}[${index}]`, scratch);
  }
  return { ctes, steps: infos, last };
}

/** Aliases (base first) whose input CTEs the compiled steps read, including sub-pipelines and sql steps. */
function collectAliases(steps: Step[], aliases: string[], found: string[]): void {
  for (const step of steps) {
    if (step.kind === "join") {
      addUnique(found, step.right.input);
      collectAliases(step.right.steps ?? [], aliases, found);
    } else if (step.kind === "sql") {
      const analysis = requireSqlAnalysis(step.query, aliases);
      for (const alias of aliases) {
        if (analysis.inputNames.includes(`in_${alias}`)) {
          addUnique(found, alias);
        }
      }
    }
  }
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
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
  const steps = def.steps.slice(0, count);
  const aliasList = def.inputs.map((input) => input.alias);
  const used = [def.base];
  collectAliases(steps, aliasList, used);
  const ctes = used.map((alias) => inputCte(getInput(inputs, alias), bag));
  const aliases = new Set(aliasList);
  const ctx: ChainContext = {
    inputs,
    bag,
    unaccent: options.unaccent ?? false,
    guards: options.guards ?? true,
    metas,
    aliases,
  };
  const scope = new FieldScope(def.base, metas, aliases);
  const compiled = compileSteps(steps, getInput(inputs, def.base).cte, ctx, scope, {
    prefix: "",
    path: "steps",
  });
  return {
    ctes: [...ctes, ...compiled.ctes],
    steps: compiled.steps,
    last: compiled.last,
    bag,
    complete: count === def.steps.length,
  };
}

import { getInput } from "./inputs.js";
import type { ResolvedInput } from "./inputs.js";
import { joinPrefix, listKey, prefixed } from "./join-names.js";
import { manualMapValues, normalizeKey } from "./keys.js";
import { measureAggregate, withEmpty } from "./measures.js";
import { buildObject, fieldJson, fieldText, ParamBag, quoteIdent } from "./sql-util.js";
import type { JoinStep, Measure, MultiMatch, Sort, Step } from "./types.js";

/** One compiled step (or sub-pipeline step), in execution order. */
export interface StepInfo {
  /** Index within its own step list. */
  index: number;
  kind: Step["kind"];
  /** Quoted CTE name feeding the step. */
  input: string;
  /** Quoted CTE name the step produced. */
  output: string;
  join?: JoinInfo;
  /** Present on sub-pipeline steps, e.g. `steps[1].right.steps[0]`. */
  path?: string;
}

export interface SubChain {
  ctes: string[];
  steps: StepInfo[];
  last: string;
}

export interface JoinContext {
  inputs: Map<string, ResolvedInput>;
  bag: ParamBag;
  unaccent: boolean;
  /** When false, the `error` mode guard is left out (diagnostics must not fail). */
  guards: boolean;
  /** Prefix for every CTE name of this chain (sub-pipelines nest by step id). */
  prefix: string;
  /** Path of the join step, e.g. `steps[1]`. */
  path: string;
  /** Compile an inline sub-pipeline over `start`, naming its CTEs with `prefix`. */
  compileSub: (alias: string, steps: Step[], prefix: string, path: string) => SubChain;
}

/** What the diagnostics query needs to know about a compiled join. */
export interface JoinInfo {
  left: string;
  right: string;
  keyCount: number;
  policy: string;
  spread?: { by: string; categories: string[] };
}

export interface JoinResult {
  ctes: string[];
  out: string;
  info: JoinInfo;
  /** Steps of the right side's sub-pipeline, compiled before the join. */
  subSteps: StepInfo[];
}

interface Names {
  map: string;
  left: string;
  right: string;
  pick: string;
  sum: string;
  out: string;
}

function keyColumns(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `k${i}`);
}

function onClause(count: number, left: string, right: string): string {
  return keyColumns(count)
    .map((col) => `${left}.${col} = ${right}.${col}`)
    .join(" and ");
}

function sideCte(
  name: string,
  from: string,
  step: JoinStep,
  side: "left" | "right",
  ctx: JoinContext,
  mapCte: string | undefined,
): string {
  const raws = step.on.map((pair) =>
    fieldText("d", ctx.bag, side === "left" ? pair.left : pair.right),
  );
  const keys = raws.map(
    (raw, i) =>
      normalizeKey(
        raw,
        step.matching,
        ctx.bag,
        { unaccent: ctx.unaccent },
        side === "left" ? mapCte : undefined,
      ) + ` as k${i}`,
  );
  const geom = side === "left" ? ", geom" : "";
  return `${name} as (
  select row_id, d${geom}, ${keys.join(", ")}, concat_ws(' | ', ${raws.join(", ")}) as kraw
  from ${from}
)`;
}

function orderClause(orderBy: Sort[] | undefined, reverse: boolean, bag: ParamBag): string {
  const parts = (orderBy ?? []).map((sort) => {
    const desc = (sort.direction === "desc") !== reverse;
    return `${fieldJson("d", bag, sort.field)} ${desc ? "desc" : "asc"} nulls last`;
  });
  parts.push(reverse ? "row_id desc" : "row_id asc");
  return parts.join(", ");
}

/** The right row's fields as one jsonb object, `<prefix>.<field>` keyed. */
function rightFields(step: JoinStep, prefix: string, ctx: JoinContext): string {
  const dotted = prefix === "" ? "" : `${prefix}.`;
  if (step.fields !== undefined) {
    const pairs = step.fields.map((field) => ({
      key: `${dotted}${field}`,
      value: fieldJson("r.d", ctx.bag, field),
    }));
    return `case when r.row_id is null then '{}'::jsonb else ${buildObject(pairs, ctx.bag)} end`;
  }
  const key = dotted === "" ? "t.key" : `${ctx.bag.text(dotted)} || t.key`;
  return `coalesce((select jsonb_object_agg(${key}, t.value) from jsonb_each(r.d) t), '{}'::jsonb)`;
}

function summarizeCte(
  name: string,
  from: string,
  step: JoinStep,
  measures: Measure[],
  ctx: JoinContext,
): string {
  const cols = keyColumns(step.on.length).join(", ");
  const aggs = measures.map(
    (measure, i) => `${measureAggregate(measure, "d", ctx.bag, "join")} as m${i}`,
  );
  const select = [cols, ...aggs].join(", ");
  return `${name} as (
  select ${select}
  from ${from}
  group by ${cols}
)`;
}

function summarizeObject(measures: Measure[], ctx: JoinContext): string {
  const pairs = measures.map((measure, i) => ({
    key: measure.as,
    value: withEmpty(`rs.m${i}`, measure, ctx.bag),
  }));
  return buildObject(pairs, ctx.bag);
}

// --- one row per key (first / last / error) ---------------------------------

function pickOneCte(step: JoinStep, names: Names, ctx: JoinContext): string {
  const { multiMatch } = step;
  const orderBy =
    multiMatch.mode === "first" || multiMatch.mode === "last" ? multiMatch.orderBy : undefined;
  const cols = keyColumns(step.on.length).join(", ");
  const order = orderClause(orderBy, multiMatch.mode === "last", ctx.bag);
  return `${names.pick} as (
  select distinct on (${cols}) row_id, d, ${cols}
  from ${names.right}
  order by ${cols}, ${order}
)`;
}

/**
 * `error` mode: one row per key like `first`, plus a `chk` column that casts
 * a message to int when a key (present on the left) has several matches. The
 * cast failure aborts the statement and the message carries the offending
 * key. Pure SQL, no helper function: `'text'::int` is the error raiser.
 */
function errorGuardCte(step: JoinStep, names: Names, ctx: JoinContext): string {
  const cols = keyColumns(step.on.length);
  const list = cols.join(", ");
  const guard = ctx.guards
    ? `case when count(*) > 1 then (${ctx.bag.text("Multiple rows match the join key: ")} || min(r.kraw))::int else 0 end`
    : "0";
  return `${names.pick} as (
  select ${list}, (array_agg(r.row_id order by r.row_id))[1] as row_id, (array_agg(r.d order by r.row_id))[1] as d, ${guard} as chk
  from ${names.right} r
  where exists (select 1 from ${names.left} x where ${onClause(step.on.length, "x", "r")})
  group by ${list}
)`;
}

// --- spread / text / list ---------------------------------------------------

function spreadCte(
  step: JoinStep,
  mm: Extract<MultiMatch, { mode: "spread" }>,
  names: Names,
  ctx: JoinContext,
): string {
  const cols = keyColumns(step.on.length).join(", ");
  const value = fieldJson("d", ctx.bag, mm.value);
  const category = fieldText("d", ctx.bag, mm.by);
  const aggs = mm.columns.map(
    (column, i) =>
      `(array_agg(${value} order by row_id) filter (where ${category} = ${ctx.bag.text(column.category)}))[1] as v${i}`,
  );
  return `${names.pick} as (
  select ${[cols, ...aggs].join(", ")}
  from ${names.right}
  group by ${cols}
)`;
}

function textCte(
  step: JoinStep,
  mm: Extract<MultiMatch, { mode: "text" }>,
  names: Names,
  ctx: JoinContext,
): string {
  const cols = keyColumns(step.on.length).join(", ");
  const text = fieldText("d", ctx.bag, mm.field);
  return `${names.pick} as (
  select ${cols}, string_agg(${text}, ${ctx.bag.text(mm.separator)} order by row_id) as t
  from ${names.right}
  group by ${cols}
)`;
}

function listCte(step: JoinStep, names: Names, ctx: JoinContext): string {
  const cols = keyColumns(step.on.length).join(", ");
  const item =
    step.fields === undefined
      ? "d"
      : buildObject(
          step.fields.map((field) => ({ key: field, value: fieldJson("d", ctx.bag, field) })),
          ctx.bag,
        );
  return `${names.pick} as (
  select ${cols}, jsonb_agg(${item} order by row_id) as items
  from ${names.right}
  group by ${cols}
)`;
}

/** The jsonb object a left row gains from its (single, grouped) right row `r`. */
function groupedObject(step: JoinStep, prefix: string, title: string, ctx: JoinContext): string {
  const mm = step.multiMatch;
  switch (mm.mode) {
    case "spread":
      return buildObject(
        mm.columns.map((column, i) => ({ key: column.as, value: `r.v${i}` })),
        ctx.bag,
      );
    case "text":
      return buildObject([{ key: prefixed(prefix, mm.field), value: "to_jsonb(r.t)" }], ctx.bag);
    case "list":
      return buildObject(
        [{ key: listKey(prefix, title), value: "coalesce(r.items, '[]'::jsonb)" }],
        ctx.bag,
      );
    case "error":
      return `case when coalesce(r.chk, 0) = 0 then ${rightFields(step, prefix, ctx)} else '{}'::jsonb end`;
    default:
      return rightFields(step, prefix, ctx);
  }
}

function groupedCte(step: JoinStep, names: Names, ctx: JoinContext): string {
  const mm = step.multiMatch;
  switch (mm.mode) {
    case "spread":
      return spreadCte(step, mm, names, ctx);
    case "text":
      return textCte(step, mm, names, ctx);
    case "list":
      return listCte(step, names, ctx);
    case "error":
      return errorGuardCte(step, names, ctx);
    default:
      return pickOneCte(step, names, ctx);
  }
}

function infoOf(step: JoinStep, names: Names): JoinInfo {
  const { multiMatch } = step;
  const info: JoinInfo = {
    left: names.left,
    right: names.right,
    keyCount: step.on.length,
    policy: multiMatch.mode,
  };
  if (multiMatch.mode === "spread") {
    info.spread = {
      by: multiMatch.by,
      categories: multiMatch.columns.map((column) => column.category),
    };
  }
  return info;
}

/** Compile one join step into its CTEs; `prev` is the previous step's CTE name. */
export function compileJoin(
  step: JoinStep,
  index: number,
  prev: string,
  ctx: JoinContext,
): JoinResult {
  const right = getInput(ctx.inputs, step.right.input);
  const name = (stem: string): string => quoteIdent(`${ctx.prefix}${stem}${index}`);
  const names: Names = {
    map: name("km"),
    left: name("l"),
    right: name("r"),
    pick: name("rf"),
    sum: name("rs"),
    out: name("s"),
  };
  const ctes: string[] = [];
  let rightFrom = right.cte;
  let subSteps: StepInfo[] = [];
  const subPipeline = step.right.steps;
  if (subPipeline !== undefined && subPipeline.length > 0) {
    const sub = ctx.compileSub(
      step.right.input,
      subPipeline,
      `${ctx.prefix}s${index}_`,
      `${ctx.path}.right.steps`,
    );
    ctes.push(...sub.ctes);
    rightFrom = sub.last;
    subSteps = sub.steps;
  }
  const mapValues = manualMapValues(step.matching, ctx.bag);
  if (mapValues !== undefined) {
    ctes.push(`${names.map}(k_from, k_to) as (${mapValues})`);
  }
  ctes.push(
    sideCte(names.left, prev, step, "left", ctx, mapValues === undefined ? undefined : names.map),
    sideCte(names.right, rightFrom, step, "right", ctx, undefined),
  );
  const joinType = step.type === "inner" ? "join" : "left join";
  const { multiMatch } = step;
  if (multiMatch.mode === "summarize") {
    ctes.push(summarizeCte(names.sum, names.right, step, multiMatch.measures, ctx));
    ctes.push(`${names.out} as (
  select l.row_id, l.d || ${summarizeObject(multiMatch.measures, ctx)} as d, l.geom
  from ${names.left} l
  ${joinType} ${names.sum} rs on ${onClause(step.on.length, "l", "rs")}
)`);
  } else {
    const prefix = joinPrefix(step, right.title);
    ctes.push(groupedCte(step, names, ctx));
    ctes.push(`${names.out} as (
  select l.row_id, l.d || ${groupedObject(step, prefix, right.title, ctx)} as d, l.geom
  from ${names.left} l
  ${joinType} ${names.pick} r on ${onClause(step.on.length, "l", "r")}
)`);
  }
  return { ctes, out: names.out, info: infoOf(step, names), subSteps };
}

import { ViewStepNotSupportedError } from "./errors.js";
import { getInput } from "./inputs.js";
import type { ResolvedInput } from "./inputs.js";
import { manualMapValues, normalizeKey } from "./keys.js";
import { measureAggregate, withEmpty } from "./measures.js";
import { buildObject, fieldJson, fieldText, ParamBag, quoteIdent, slugify } from "./sql-util.js";
import type { JoinStep, Measure, Sort } from "./types.js";

export interface JoinContext {
  inputs: Map<string, ResolvedInput>;
  bag: ParamBag;
  unaccent: boolean;
}

/** What the diagnostics query needs to know about a compiled join. */
export interface JoinInfo {
  left: string;
  right: string;
  keyCount: number;
  policy: string;
}

export interface JoinResult {
  ctes: string[];
  out: string;
  info: JoinInfo;
}

/** Fail fast (before emitting SQL) on joins this package cannot compile. */
function assertSupported(step: JoinStep): void {
  if (step.right.steps !== undefined && step.right.steps.length > 0) {
    throw new ViewStepNotSupportedError("join", "sub-pipeline");
  }
  const { multiMatch } = step;
  if (multiMatch.mode === "summarize") {
    for (const measure of multiMatch.measures) {
      measureAggregate(measure, "d", new ParamBag(), "join");
    }
    return;
  }
  if (multiMatch.mode !== "first" && multiMatch.mode !== "last") {
    throw new ViewStepNotSupportedError("join", multiMatch.mode);
  }
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

function prefixOf(step: JoinStep, right: ResolvedInput): string {
  return step.prefix ?? slugify(right.title);
}

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

/** Compile one join step into its CTEs; `prev` is the previous step's CTE name. */
export function compileJoin(
  step: JoinStep,
  index: number,
  prev: string,
  ctx: JoinContext,
): JoinResult {
  assertSupported(step);
  const right = getInput(ctx.inputs, step.right.input);
  const names = {
    map: quoteIdent(`km${index}`),
    left: quoteIdent(`l${index}`),
    right: quoteIdent(`r${index}`),
    pick: quoteIdent(`rf${index}`),
    sum: quoteIdent(`rs${index}`),
    out: quoteIdent(`s${index}`),
  };
  const ctes: string[] = [];
  const mapValues = manualMapValues(step.matching, ctx.bag);
  if (mapValues !== undefined) {
    ctes.push(`${names.map}(k_from, k_to) as (${mapValues})`);
  }
  ctes.push(
    sideCte(names.left, prev, step, "left", ctx, mapValues === undefined ? undefined : names.map),
    sideCte(names.right, right.cte, step, "right", ctx, undefined),
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
    ctes.push(pickOneCte(step, names, ctx));
    ctes.push(`${names.out} as (
  select l.row_id, l.d || ${rightFields(step, prefixOf(step, right), ctx)} as d, l.geom
  from ${names.left} l
  ${joinType} ${names.pick} r on ${onClause(step.on.length, "l", "r")}
)`);
  }
  return {
    ctes,
    out: names.out,
    info: {
      left: names.left,
      right: names.right,
      keyCount: step.on.length,
      policy: multiMatch.mode,
    },
  };
}

function pickOneCte(
  step: JoinStep,
  names: { right: string; pick: string },
  ctx: JoinContext,
): string {
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

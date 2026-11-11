/**
 * Compile a `sql` step into CTEs. The user's SELECT becomes `<out>_q` (with
 * `prev` pointed at the previous step's CTE), and `<out>` folds its output
 * columns into the `(row_id, d, geom)` row shape. See sql-step.ts for the
 * output-shape rule and the safety checks.
 */

import { ViewCompileError } from "./errors.js";
import { analyzeSqlStep, rewritePrev } from "./sql-step.js";
import type { SqlStepAnalysis } from "./sql-step.js";
import { buildObject, ParamBag, quoteIdent } from "./sql-util.js";

const RESERVED_COLUMNS = new Set(["d", "row_id", "geom"]);

/** Analyze a sql step for compilation, throwing a located ViewCompileError when it is invalid. */
export function requireSqlAnalysis(query: string, aliases: string[]): SqlStepAnalysis {
  const result = analyzeSqlStep(query, aliases);
  if (!result.ok) {
    const [first] = result.errors;
    throw new ViewCompileError(`sql step: ${first.message} (at ${first.start}).`);
  }
  return result.analysis;
}

function propertiesExpr(analysis: SqlStepAnalysis, bag: ParamBag): string {
  const extras = analysis.columns.filter((name) => !RESERVED_COLUMNS.has(name));
  const pairs = extras.map((name) => ({ key: name, value: `to_jsonb(q.${quoteIdent(name)})` }));
  if (analysis.columns.includes("d")) {
    const base = `coalesce(to_jsonb(q."d"), '{}'::jsonb)`;
    return pairs.length === 0 ? base : `${base} || ${buildObject(pairs, bag)}`;
  }
  return buildObject(pairs, bag);
}

export function compileSqlStep(
  analysis: SqlStepAnalysis,
  prev: string,
  out: string,
  rawName: string,
  bag: ParamBag,
): string[] {
  const hasRowId = analysis.columns.includes("row_id");
  const rid = hasRowId ? `(q."row_id")::text::uuid` : "null::uuid";
  const geom = analysis.columns.includes("geom") ? `q."geom"` : "null::geometry(Geometry,4326)";
  const identity = hasRowId
    ? "f.rid"
    : `md5(f.d::text || ':' || (row_number() over (partition by f.d::text))::text)::uuid`;
  const raw = `${rawName} as (
${rewritePrev(analysis, prev)}
)`;
  const folded = `${out} as (
  select ${identity} as row_id, f.d, f.geom
  from (select ${propertiesExpr(analysis, bag)} as d, ${geom} as geom, ${rid} as rid from ${rawName} q) f
)`;
  return [raw, folded];
}

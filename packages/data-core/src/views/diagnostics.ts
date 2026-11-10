/**
 * The diagnostics query (design §8): per-step row counts and field changes,
 * plus per-join match statistics. It reuses the CTE chain of the row query,
 * so the numbers describe exactly the rows a run would save.
 */

import type { StepInfo } from "./chain.js";
import { ParamBag } from "./sql-util.js";

const SAMPLE_CAP = 20;

function keysOf(cte: string): string {
  return `select jsonb_object_keys(d) from ${cte}`;
}

function fieldDelta(from: string, to: string): string {
  return `coalesce((select jsonb_agg(k order by k) from ((${keysOf(from)}) except (${keysOf(to)})) t(k)), '[]'::jsonb)`;
}

function hasMatch(other: string, keyCount: number, alias: string): string {
  const on = Array.from({ length: keyCount }, (_, i) => `o.k${i} = ${alias}.k${i}`).join(" and ");
  return `exists (select 1 from ${other} o where ${on})`;
}

function samples(cte: string, other: string, keyCount: number): string {
  const unmatched = `not ${hasMatch(other, keyCount, "x")}`;
  return `coalesce((select jsonb_agg(kraw order by kraw) from (select distinct kraw from ${cte} x where kraw <> '' and ${unmatched} order by kraw limit ${SAMPLE_CAP}) s), '[]'::jsonb)`;
}

function joinDiagnostics(info: NonNullable<StepInfo["join"]>, bag: ParamBag): string {
  const { left, right, keyCount, policy } = info;
  const keyCols = Array.from({ length: keyCount }, (_, i) => `r.k${i}`).join(", ");
  const leftMatched = `(select count(*) from ${left} x where ${hasMatch(right, keyCount, "x")})`;
  const rightMatched = `(select count(*) from ${right} x where ${hasMatch(left, keyCount, "x")})`;
  const multi = `(select count(*) from (select ${keyCols} from ${right} r where ${hasMatch(left, keyCount, "r")} group by ${keyCols} having count(*) > 1) m)`;
  return `jsonb_build_object(
      'leftMatched', ${leftMatched},
      'leftUnmatched', (select count(*) from ${left}) - ${leftMatched},
      'leftUnmatchedSamples', ${samples(left, right, keyCount)},
      'rightMatched', ${rightMatched},
      'rightUnmatched', (select count(*) from ${right}) - ${rightMatched},
      'rightUnmatchedSamples', ${samples(right, left, keyCount)},
      'multiMatchKeys', ${multi},
      'policy', ${bag.text(policy)}
    )`;
}

function stepDiagnostics(step: StepInfo, bag: ParamBag): string {
  const parts = [
    `'index', ${step.index}`,
    `'kind', ${bag.text(step.kind)}`,
    `'rowsIn', (select count(*) from ${step.input})`,
    `'rowsOut', (select count(*) from ${step.output})`,
    `'fieldsAdded', ${fieldDelta(step.output, step.input)}`,
    `'fieldsRemoved', ${fieldDelta(step.input, step.output)}`,
  ];
  if (step.join !== undefined) {
    parts.push(`'join', ${joinDiagnostics(step.join, bag)}`);
  }
  return `jsonb_build_object(
    ${parts.join(",\n    ")}
  )`;
}

/** The final SELECT: one row, one `diagnostics jsonb` column. */
export function diagnosticsSelect(steps: StepInfo[], bag: ParamBag): string {
  const objects = steps.map((step) => stepDiagnostics(step, bag));
  const array =
    objects.length === 0 ? "'[]'::jsonb" : `jsonb_build_array(\n  ${objects.join(",\n  ")}\n)`;
  return `select jsonb_build_object('steps', ${array}) as diagnostics`;
}

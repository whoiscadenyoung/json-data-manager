/**
 * The diagnostics query (design §8): per-node row counts and field changes,
 * plus per-join match statistics. It reuses the CTE chain of the row query,
 * so the numbers describe exactly the rows a run would save.
 */

import type { NodeInfo } from "./chain.js";
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

/**
 * Categories found among the matched right rows that have no declared
 * spread column (they never add columns; this only reports them).
 */
function spreadDiagnostics(
  spread: NonNullable<NonNullable<NodeInfo["join"]>["spread"]>,
  info: NonNullable<NodeInfo["join"]>,
  bag: ParamBag,
): string {
  const { left, right, keyCount } = info;
  const category = `(r.d ->> ${bag.text(spread.by)})`;
  const undeclared = `from ${right} r where ${category} is not null and ${category} not in (select jsonb_array_elements_text(${bag.jsonb(spread.categories)})) and ${hasMatch(left, keyCount, "r")}`;
  return `jsonb_build_object(
        'undeclaredCategories', coalesce((select jsonb_agg(c order by c) from (select distinct ${category} as c ${undeclared} order by c limit ${SAMPLE_CAP}) s), '[]'::jsonb),
        'undeclaredRows', (select count(*) ${undeclared})
      )`;
}

function joinDiagnostics(info: NonNullable<NodeInfo["join"]>, bag: ParamBag): string {
  const { left, right, keyCount, policy } = info;
  const keyCols = Array.from({ length: keyCount }, (_, i) => `r.k${i}`).join(", ");
  const leftMatched = `(select count(*) from ${left} x where ${hasMatch(right, keyCount, "x")})`;
  const rightMatched = `(select count(*) from ${right} x where ${hasMatch(left, keyCount, "x")})`;
  const multi = `(select count(*) from (select ${keyCols} from ${right} r where ${hasMatch(left, keyCount, "r")} group by ${keyCols} having count(*) > 1) m)`;
  const extra =
    info.spread === undefined
      ? ""
      : `,
      'spread', ${spreadDiagnostics(info.spread, info, bag)}`;
  return `jsonb_build_object(
      'leftMatched', ${leftMatched},
      'leftUnmatched', (select count(*) from ${left}) - ${leftMatched},
      'leftUnmatchedSamples', ${samples(left, right, keyCount)},
      'rightMatched', ${rightMatched},
      'rightUnmatched', (select count(*) from ${right}) - ${rightMatched},
      'rightUnmatchedSamples', ${samples(right, left, keyCount)},
      'multiMatchKeys', ${multi},
      'policy', ${bag.text(policy)}${extra}
    )`;
}

function nodeDiagnostics(node: NodeInfo, bag: ParamBag): string {
  const rowsOut = `(select count(*) from ${node.output})`;
  // A stack takes in every input's rows; any other node reports the rows of its main input.
  const counted = node.kind === "stack" ? node.inputs : node.inputs.slice(0, 1);
  const rowsIn =
    counted.length === 0
      ? rowsOut
      : counted.map((input) => `(select count(*) from ${input})`).join(" + ");
  const [first] = node.inputs;
  const fields =
    first === undefined
      ? ["'fieldsAdded', '[]'::jsonb", "'fieldsRemoved', '[]'::jsonb"]
      : [
          `'fieldsAdded', ${fieldDelta(node.output, first)}`,
          `'fieldsRemoved', ${fieldDelta(first, node.output)}`,
        ];
  const parts = [
    `'id', ${bag.text(node.id)}`,
    `'kind', ${bag.text(node.kind)}`,
    `'rowsIn', ${rowsIn}`,
    `'rowsOut', ${rowsOut}`,
    ...fields,
  ];
  if (node.join !== undefined) {
    parts.push(`'join', ${joinDiagnostics(node.join, bag)}`);
  }
  return `jsonb_build_object(
    ${parts.join(",\n    ")}
  )`;
}

/** The final SELECT: one row, one `diagnostics jsonb` column. */
export function diagnosticsSelect(nodes: NodeInfo[], bag: ParamBag): string {
  const objects = nodes.map((node) => nodeDiagnostics(node, bag));
  const array =
    objects.length === 0 ? "'[]'::jsonb" : `jsonb_build_array(\n  ${objects.join(",\n  ")}\n)`;
  return `select jsonb_build_object('nodes', ${array}) as diagnostics`;
}

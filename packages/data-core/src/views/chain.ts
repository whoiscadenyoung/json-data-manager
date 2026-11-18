import { compileCalculate } from "./calculate.js";
import { analyzeExpression } from "./calculate.js";
import { onlyRow, editedRow, tagPatch } from "./columns.js";
import { compileCondition } from "./condition.js";
import { ViewCompileError } from "./errors.js";
import { dependencyOrder, describeCycle } from "./graph.js";
import { compileJoin } from "./join.js";
import type { JoinContext, JoinInfo } from "./join.js";
import { measureExpr } from "./measures.js";
import { resolveSource, sourceCte } from "./sources.js";
import { compileSqlStep, requireSqlAnalysis } from "./sql-compile.js";
import { buildObject, fieldJson, nodeCteName, ParamBag, quoteIdent } from "./sql-util.js";
import type { CompileInputMeta, NodeKind, ViewDefinition, ViewNode } from "./types.js";
import { GraphScope } from "./validate-fields.js";
import type { FieldMap } from "./validate-fields.js";

/** One compiled node, for diagnostics. */
export interface NodeInfo {
  id: string;
  kind: NodeKind;
  /** Quoted CTE names of the nodes it reads (empty for a source). */
  inputs: string[];
  /** Quoted CTE name the node produced. */
  output: string;
  join?: JoinInfo;
}

export type { JoinInfo } from "./join.js";

export interface Chain {
  ctes: string[];
  /** Every compiled node, dependencies first. */
  nodes: NodeInfo[];
  /** Quoted name of the CTE holding the target node's rows. */
  last: string;
  bag: ParamBag;
  /** True when the target is the result node (the output schema applies). */
  complete: boolean;
}

export interface ChainOptions {
  uptoNode?: string;
  unaccent?: boolean;
  /** False for diagnostics: the `error` multi-match guard must not abort the query. */
  guards?: boolean;
}

type Of<K extends NodeKind> = Extract<ViewNode, { kind: K }>;

interface Compiled {
  ctes: string[];
  info: NodeInfo;
}

interface Ctx {
  def: ViewDefinition;
  metas: CompileInputMeta[];
  bag: ParamBag;
  scope: GraphScope;
  joins: JoinContext;
}

function simple(id: string, node: ViewNode, inputs: string[], ctes: string[]): Compiled {
  const output = nodeCteName(id);
  return { ctes, info: { id, kind: node.kind, inputs, output } };
}

function compileFilter(id: string, node: Of<"filter">, ctx: Ctx): Compiled {
  const from = nodeCteName(node.from);
  const out = nodeCteName(id);
  return simple(
    id,
    node,
    [from],
    [
      `${out} as (
  select row_id, d, geom
  from ${from}
  where ${compileCondition(node.where, "d", ctx.bag)}
)`,
    ],
  );
}

function compileColumns(id: string, node: Of<"columns">, ctx: Ctx): Compiled {
  const from = nodeCteName(node.from);
  const out = nodeCteName(id);
  const row = onlyRow(editedRow(node.edits, ctx.bag), node.only, ctx.bag);
  return simple(
    id,
    node,
    [from],
    [
      `${out} as (
  select row_id, ${row} as d, geom
  from ${from}
)`,
    ],
  );
}

/** One CTE per calculated field so later fields can read earlier ones; the last is the node. */
function compileCalculateNode(id: string, node: Of<"calculate">, ctx: Ctx): Compiled {
  const from = nodeCteName(node.from);
  const input = ctx.scope.fieldsOf(node.from);
  const known: FieldMap | undefined = input === undefined ? undefined : new Map(input);
  const ctes: string[] = [];
  let prev = from;
  for (const [i, field] of node.fields.entries()) {
    const last = i === node.fields.length - 1;
    const name = last ? nodeCteName(id) : quoteIdent(`c${i}_${id}`);
    const resolver = GraphScope.resolver(known);
    ctes.push(compileCalculate(field, prev, name, ctx.bag, resolver));
    const analysis = analyzeExpression(field.expr, resolver);
    if (known !== undefined) {
      known.set(field.field, analysis.ok ? analysis.type : "unknown");
    }
    prev = name;
  }
  return simple(id, node, [from], ctes);
}

function compileGroupBy(id: string, node: Of<"groupBy">, ctx: Ctx): Compiled {
  if (node.by.length === 0) {
    throw new ViewCompileError("groupBy needs at least one field in `by`.");
  }
  const { bag } = ctx;
  const from = nodeCteName(node.from);
  const out = nodeCteName(id);
  const keys = node.by.map((field, i) => `${fieldJson("d", bag, field)} as g${i}`);
  const groupCols = node.by.map((_, i) => `g${i}`);
  const keyPairs = node.by.map((field, i) => ({ key: field, value: `g${i}` }));
  const measurePairs = node.measures.map((measure) => ({
    key: measure.as,
    value: measureExpr(measure, "d", bag, "groupBy"),
  }));
  const object = buildObject([...keyPairs, ...measurePairs], bag);
  const identity = `md5(jsonb_build_array(${groupCols.join(", ")})::text)::uuid`;
  return simple(
    id,
    node,
    [from],
    [
      `${out} as (
  select ${identity} as row_id, ${object} as d, null::geometry(Geometry,4326) as geom
  from (select d, ${keys.join(", ")} from ${from}) t
  group by ${groupCols.join(", ")}
)`,
    ],
  );
}

function compileStack(id: string, node: Of<"stack">, ctx: Ctx): Compiled {
  const out = nodeCteName(id);
  const inputs = node.inputs.map((input) => nodeCteName(input.node));
  const parts = node.inputs.map(
    (input, i) =>
      `select row_id, ${tagPatch(node.tagField, input.tag, input.columns, ctx.bag)} as d, geom from ${inputs[i]}`,
  );
  return simple(id, node, inputs, [
    `${out} as (
  ${parts.join("\n  union all\n  ")}
)`,
  ]);
}

function compileSql(id: string, node: Of<"sql">, ctx: Ctx): Compiled {
  const from = nodeCteName(node.from);
  const analysis = requireSqlAnalysis(node.query, [node.from, ...(node.reads ?? [])]);
  const raw = quoteIdent(`q_${id}`);
  const ctes = compileSqlStep(analysis, from, nodeCteName(id), raw, ctx.bag);
  return simple(id, node, [from, ...(node.reads ?? []).map((read) => nodeCteName(read))], ctes);
}

function compileJoinNode(id: string, node: Of<"join">, ctx: Ctx): Compiled {
  const left = nodeCteName(node.left);
  const right = nodeCteName(node.right);
  const out = nodeCteName(id);
  const joined = compileJoin(node, id, left, right, ctx.scope.titleOf(node.right), out, ctx.joins);
  return {
    ctes: joined.ctes,
    info: { id, kind: "join", inputs: [left, right], output: out, join: joined.info },
  };
}

function compileNode(id: string, ctx: Ctx): Compiled {
  const node = ctx.def.nodes[id];
  switch (node.kind) {
    case "source":
      return simple(id, node, [], [sourceCte(resolveSource(ctx.def, ctx.metas, id), ctx.bag)]);
    case "filter":
      return compileFilter(id, node, ctx);
    case "columns":
      return compileColumns(id, node, ctx);
    case "calculate":
      return compileCalculateNode(id, node, ctx);
    case "groupBy":
      return compileGroupBy(id, node, ctx);
    case "sql":
      return compileSql(id, node, ctx);
    case "join":
      return compileJoinNode(id, node, ctx);
    case "stack":
      return compileStack(id, node, ctx);
    default:
      throw new ViewCompileError(`Unknown node kind ${JSON.stringify(node)}.`);
  }
}

function orderFor(def: ViewDefinition, target: string): string[] {
  if (!Object.hasOwn(def.nodes, target)) {
    throw new ViewCompileError(`Unknown node "${target}".`);
  }
  const order = dependencyOrder(def.nodes, target);
  if (order.ok) {
    return order.order;
  }
  if ("cycle" in order) {
    throw new ViewCompileError(
      `Node "${order.cycle[0]}" reads itself: ${describeCycle(order.cycle)}`,
    );
  }
  throw new ViewCompileError(`Node "${order.reader}" reads unknown node "${order.missing}".`);
}

/** Build one CTE group per ancestor of the target node. Shared by rows and diagnostics. */
export function buildChain(
  def: ViewDefinition,
  metas: CompileInputMeta[],
  options: ChainOptions,
): Chain {
  const target = options.uptoNode ?? def.result.node;
  const order = orderFor(def, target);
  const bag = new ParamBag();
  const ctx: Ctx = {
    def,
    metas,
    bag,
    scope: new GraphScope(def.nodes, metas),
    joins: { bag, unaccent: options.unaccent ?? false, guards: options.guards ?? true },
  };
  const ctes: string[] = [];
  const nodes: NodeInfo[] = [];
  for (const id of order) {
    const compiled = compileNode(id, ctx);
    ctes.push(...compiled.ctes);
    nodes.push(compiled.info);
  }
  return {
    ctes,
    nodes,
    last: nodeCteName(target),
    bag,
    complete: target === def.result.node,
  };
}

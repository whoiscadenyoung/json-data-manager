/**
 * Reuse without templates (ADR 0028 §7, graph addendum): pure helpers behind
 * Duplicate, source remap, Prune and Extract to view. No I/O; the app wires
 * them to the store.
 */
import { reachableIds, readersOf } from "./graph.js";
import { joinPrefix } from "./join-names.js";
import { slugify } from "./sql-util.js";
import type {
  CompileInputMeta,
  JoinNode,
  ValidationError,
  ViewDefinition,
  ViewNode,
} from "./types.js";
import { validateViewDefinition } from "./validate.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Join modes whose output names are built from the join prefix. */
function usesPrefix(step: JoinNode): boolean {
  return step.multiMatch.mode !== "summarize" && step.multiMatch.mode !== "spread";
}

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------

/** A node id not in `taken`, derived from a label (lowercase letters, digits, underscores). */
export function freshNodeId(label: string, taken: readonly string[]): string {
  const base = slugify(label);
  if (!taken.includes(base)) {
    return base;
  }
  let n = 2;
  while (taken.includes(`${base}_${n}`)) {
    n += 1;
  }
  return `${base}_${n}`;
}

const kindsWithFrom = new Set(["filter", "columns", "calculate", "groupBy", "sql"]);

function renameRefs(node: ViewNode, from: string, to: string): ViewNode {
  const swap = (id: string): string => (id === from ? to : id);
  if (kindsWithFrom.has(node.kind) && "from" in node) {
    const next = { ...node, from: swap(node.from) };
    if (next.kind === "sql") {
      return {
        ...next,
        ...(next.reads === undefined ? {} : { reads: next.reads.map(swap) }),
        query: next.query.replaceAll(new RegExp(`\\bin_${from}\\b`, "g"), `in_${to}`),
      };
    }
    return next;
  }
  if (node.kind === "join") {
    return { ...node, left: swap(node.left), right: swap(node.right) };
  }
  if (node.kind === "stack") {
    return { ...node, inputs: node.inputs.map((input) => ({ ...input, node: swap(input.node) })) };
  }
  return node;
}

/** The definition with node id `from` renamed to `to` everywhere it is referenced (key order kept). */
export function renameNodeId(def: ViewDefinition, from: string, to: string): ViewDefinition {
  if (from === to) {
    return def;
  }
  const nodes: Record<string, ViewNode> = {};
  for (const [id, node] of Object.entries(def.nodes)) {
    nodes[id === from ? to : id] = renameRefs(node, from, to);
  }
  return {
    nodes,
    result: { ...def.result, node: def.result.node === from ? to : def.result.node },
  };
}

/** Drops nodes that are not ancestors of the result node ("Prune unused"). */
export function pruneNodes(def: ViewDefinition): ViewDefinition {
  const keep = reachableIds(def);
  const nodes: Record<string, ViewNode> = {};
  for (const [id, node] of Object.entries(def.nodes)) {
    if (keep.has(id)) {
      nodes[id] = node;
    }
  }
  return { ...def, nodes };
}

/** Ids of nodes the result does not need (shown as "Unused"). */
export function unusedNodeIds(def: ViewDefinition): string[] {
  const keep = reachableIds(def);
  return Object.keys(def.nodes).filter((id) => !keep.has(id));
}

export interface NodeUsage {
  /** The reading node. */
  node: string;
  /** In the editor's words, e.g. "Join (clean_d1)". */
  label: string;
}

/**
 * Who reads each node: the nodes that list it as an input, plus "Result" for
 * the result node. Nodes nothing reads map to an empty list.
 */
export function nodeUsages(def: ViewDefinition): Map<string, NodeUsage[]> {
  const usages = new Map<string, NodeUsage[]>();
  for (const [id, readers] of readersOf(def)) {
    usages.set(
      id,
      readers.map((reader) => ({ node: reader, label: def.nodes[reader].label ?? reader })),
    );
  }
  const list = usages.get(def.result.node);
  if (list !== undefined) {
    list.push({ node: "result", label: "Result" });
  }
  return usages;
}

// ---------------------------------------------------------------------------
// Duplicate and remap
// ---------------------------------------------------------------------------

/** "<title> (copy)". */
export function copyTitle(title: string): string {
  return `${title} (copy)`;
}

/** A deep copy of the definition: nodes and the output schema with its labels. */
export function duplicateDefinition(definition: ViewDefinition): ViewDefinition {
  return clone(definition);
}

export interface SourceRemap {
  /** Which source node is re-pointed. */
  node: string;
  /** The dataset or view it reads instead. */
  datasetId: string;
  /** The title the source had before (so default join prefixes keep their names). */
  oldTitle: string;
}

/**
 * The definition with some sources re-pointed at other datasets/views. Node
 * ids stay (other nodes refer to them). A pinned version belongs to the old
 * dataset and is dropped. A join whose right node is a remapped source keeps
 * its output names: the default prefix (a slug of the old title) is written
 * down explicitly.
 */
export function remapSources(
  definition: ViewDefinition,
  remaps: readonly SourceRemap[],
): ViewDefinition {
  const out = clone(definition);
  const changed = remaps.filter((remap) => {
    const node = out.nodes[remap.node];
    return node !== undefined && node.kind === "source" && node.ref.id !== remap.datasetId;
  });
  const oldTitles = new Map(changed.map((remap) => [remap.node, remap.oldTitle]));
  for (const remap of changed) {
    const node = out.nodes[remap.node];
    if (node.kind === "source") {
      node.ref = { kind: "dataset", id: remap.datasetId };
    }
  }
  for (const node of Object.values(out.nodes)) {
    if (node.kind !== "join" || node.prefix !== undefined || !usesPrefix(node)) {
      continue;
    }
    const oldTitle = oldTitles.get(node.right);
    if (oldTitle !== undefined) {
      node.prefix = joinPrefix(node, oldTitle);
    }
  }
  return out;
}

/** Where a validation error is, in the editor's words (the node id, "Output", "Definition"). */
export function nodeLabelOfPath(path: string): string {
  const match = /^nodes\.([a-z0-9_]+)/.exec(path);
  if (match !== null) {
    return match[1] ?? "";
  }
  return path.startsWith("result") ? "Output" : "Definition";
}

export interface RemapProblem {
  /** The node id, "Output" or "Definition". */
  node: string;
  path: string;
  message: string;
}

export type RemapReport =
  | { ok: true; definition: ViewDefinition }
  | { ok: false; problems: RemapProblem[]; byNode: { node: string; messages: string[] }[] };

function problemOf(error: ValidationError): RemapProblem {
  return { node: nodeLabelOfPath(error.path), path: error.path, message: error.message };
}

/**
 * Validates a (remapped) definition with the REAL validator against the new
 * sources' fields, and groups the problems per node ("clean_d1: no field
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
  const byNode: { node: string; messages: string[] }[] = [];
  for (const problem of problems) {
    const group = byNode.find((entry) => entry.node === problem.node);
    if (group === undefined) {
      byNode.push({ node: problem.node, messages: [problem.message] });
    } else if (!group.messages.includes(problem.message)) {
      group.messages.push(problem.message);
    }
  }
  return { ok: false, problems, byNode };
}

// ---------------------------------------------------------------------------
// Extract to view
// ---------------------------------------------------------------------------

/** Whether "Extract to view" applies: any node that is not already a plain source. */
export function canExtract(definition: ViewDefinition, id: string): boolean {
  return Object.hasOwn(definition.nodes, id) && definition.nodes[id].kind !== "source";
}

export interface ExtractPlan {
  /** The new view: the node's ancestor subgraph, saved with every field. */
  view: ViewDefinition;
  /** The node's readable title before the extract (names the default join prefix). */
  oldTitle: string;
}

export type ExtractResult = { ok: true; plan: ExtractPlan } | { ok: false; reason: string };

/** The new view for "Extract to view" on node `id`. */
export function planExtract(definition: ViewDefinition, id: string): ExtractResult {
  if (!canExtract(definition, id)) {
    return { ok: false, reason: "Only a processing node can be extracted into its own view." };
  }
  const subgraph = pruneNodes({
    nodes: clone(definition.nodes),
    result: { node: id, output: { fields: [], emptyFields: "keep" } },
  });
  return { ok: true, plan: { view: subgraph, oldTitle: definition.nodes[id].label ?? id } };
}

/**
 * The edited definition once the new view exists: node `id` becomes a source
 * reading it (same id, so readers are untouched), joins that read it keep
 * their default prefix, and nodes only the extracted subgraph needed are pruned.
 */
export function applyExtract(
  definition: ViewDefinition,
  id: string,
  plan: ExtractPlan,
  created: { id: string },
): ViewDefinition {
  const out = clone(definition);
  const node = out.nodes[id];
  out.nodes[id] = {
    kind: "source",
    ref: { kind: "dataset", id: created.id },
    ...(node.label === undefined ? {} : { label: node.label }),
  };
  for (const reader of Object.values(out.nodes)) {
    if (
      reader.kind === "join" &&
      reader.right === id &&
      reader.prefix === undefined &&
      usesPrefix(reader)
    ) {
      reader.prefix = joinPrefix(reader, plan.oldTitle);
    }
  }
  return pruneNodes(out);
}

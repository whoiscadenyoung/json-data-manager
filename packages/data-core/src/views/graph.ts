/**
 * Graph helpers over `ViewDefinition.nodes`: who reads whom, dependency
 * order, reachability and cycles. Pure and tolerant of malformed input
 * (references to missing nodes are skipped; the validator reports them).
 */
import type { ViewDefinition, ViewNode } from "./types.js";

/** Ids of the nodes `node` reads (sql nodes: `from` first, then `reads`). */
export function nodeInputs(node: ViewNode): string[] {
  switch (node.kind) {
    case "source":
      return [];
    case "join":
      return [node.left, node.right];
    case "stack":
      return node.inputs.map((input) => input.node);
    case "sql":
      return [node.from, ...(node.reads ?? [])];
    default:
      return [node.from];
  }
}

/** Distinct input ids in order. */
export function distinctInputs(node: ViewNode): string[] {
  return [...new Set(nodeInputs(node))];
}

export type DependencyOrder =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] }
  | { ok: false; missing: string; reader: string };

/** `a → b → a`, the message form of a cycle. */
export function describeCycle(cycle: string[]): string {
  return cycle.join(" → ");
}

/**
 * Node ids needed for `target`, dependencies first (depth-first, ties by
 * `nodes` key order via the order inputs are listed).
 */
export function dependencyOrder(nodes: Record<string, ViewNode>, target: string): DependencyOrder {
  const order: string[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string, reader: string): DependencyOrder | undefined => {
    if (done.has(id)) {
      return undefined;
    }
    const at = stack.indexOf(id);
    if (at !== -1) {
      return { ok: false, cycle: [...stack.slice(at), id] };
    }
    if (!Object.hasOwn(nodes, id)) {
      return { ok: false, missing: id, reader };
    }
    stack.push(id);
    for (const input of distinctInputs(nodes[id])) {
      const failure = visit(input, id);
      if (failure !== undefined) {
        return failure;
      }
    }
    stack.pop();
    done.add(id);
    order.push(id);
    return undefined;
  };
  const failure = visit(target, "result");
  return failure ?? { ok: true, order };
}

/** The first cycle found anywhere in the graph (reachable or not), as `[a, b, a]`. */
export function findCycle(nodes: Record<string, ViewNode>): string[] | undefined {
  for (const id of Object.keys(nodes)) {
    const result = dependencyOrder(nodes, id);
    if (!result.ok && "cycle" in result) {
      return result.cycle;
    }
  }
  return undefined;
}

/** Ids that are ancestors of (or are) `result.node`. Empty when it is missing. */
export function reachableIds(def: ViewDefinition): Set<string> {
  const result = dependencyOrder(def.nodes, def.result.node);
  if (result.ok) {
    return new Set(result.order);
  }
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id) || !Object.hasOwn(def.nodes, id)) {
      return;
    }
    seen.add(id);
    for (const input of nodeInputs(def.nodes[id])) {
      walk(input);
    }
  };
  walk(def.result.node);
  return seen;
}

/** For each node, the ids of the nodes that read it (in `nodes` key order). */
export function readersOf(def: ViewDefinition): Map<string, string[]> {
  const readers = new Map<string, string[]>(Object.keys(def.nodes).map((id) => [id, []]));
  for (const [id, node] of Object.entries(def.nodes)) {
    for (const input of distinctInputs(node)) {
      const list = readers.get(input);
      if (list !== undefined) {
        list.push(id);
      }
    }
  }
  return readers;
}

/** Ids of the `source` nodes, in `nodes` key order. */
export function sourceIds(def: ViewDefinition): string[] {
  return Object.entries(def.nodes)
    .filter(([, node]) => node.kind === "source")
    .map(([id]) => id);
}

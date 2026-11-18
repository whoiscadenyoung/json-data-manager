import type { ViewDefinition } from "@caden/data-core/views";

import type { Graph, GraphEdge, GraphNode, GraphNodeBadge } from "./graph-types";

/** What an editor knows about a node that the stored JSON alone doesn't say. */
export interface NodeOverride {
  label?: string;
  detail?: string;
  badge?: GraphNodeBadge;
}

export interface NodeGraphOptions {
  /** Replaces a node's label, detail and badge (e.g. its label, the one-line summary, "Needs input"). */
  describeNode?: (id: string) => NodeOverride | undefined;
  /** The output node's second line. */
  outputDetail?: string;
}

/**
 * Nodes are read loosely on purpose. The real `ViewNode` union is open:
 * stored definitions can hold kinds this build doesn't know yet, and those
 * must still draw as generic nodes.
 */
type Loose = Record<string, unknown>;

const KIND_TITLES: Record<string, string> = {
  calculate: "Calculate",
  columns: "Columns",
  filter: "Filter",
  groupBy: "Group by",
  join: "Join",
  source: "Dataset",
  sql: "SQL",
  stack: "Stack",
};

function isLoose(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looseOf(value: unknown): Loose {
  return isLoose(value) ? value : {};
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function kindOf(node: Loose): string {
  const kind = node["kind"];
  return typeof kind === "string" && kind !== "" ? kind : "unknown";
}

/** The ids a node reads, in order, whatever its kind. */
function inputsOf(node: Loose): string[] {
  switch (kindOf(node)) {
    case "join":
      return stringsOf([node["left"], node["right"]]);
    case "stack":
      return Array.isArray(node["inputs"])
        ? node["inputs"].flatMap((input) => stringsOf([looseOf(input)["node"]]))
        : [];
    case "sql":
      return stringsOf([node["from"], ...stringsOf(node["reads"])]);
    case "source":
      return [];
    default:
      return stringsOf([node["from"]]);
  }
}

function joinDetail(node: Loose): string | undefined {
  const right = node["right"];
  const type = node["type"] === "inner" ? "Inner" : "Left";
  return typeof right === "string" && right !== "" ? `${type} join ${right}` : undefined;
}

/** Text a node shows when the editor describes nothing: a hint from the stored JSON. */
const DETAIL: Record<string, (node: Loose) => string | undefined> = {
  calculate: (node) => {
    const names = Array.isArray(node["fields"])
      ? node["fields"].flatMap((field) => stringsOf([looseOf(field)["field"]]))
      : [];
    return names.length === 0 ? undefined : names.join(", ");
  },
  columns: (node) => {
    const edits = node["edits"];
    return Array.isArray(edits) ? `${edits.length} column edits` : undefined;
  },
  groupBy: (node) => {
    const by = stringsOf(node["by"]);
    return by.length === 0 ? undefined : `by ${by.join(", ")}`;
  },
  join: joinDetail,
  stack: (node) => {
    const inputs = node["inputs"];
    return Array.isArray(inputs) && inputs.length > 0 ? `${inputs.length} stacked` : undefined;
  },
};

const nodeKey = (id: string): string => `node:${id}`;

function graphNode(id: string, node: Loose, override: NodeOverride = {}): GraphNode {
  const kind = kindOf(node);
  const label = node["label"];
  return {
    badge: override.badge,
    detail: override.detail ?? (DETAIL[kind] === undefined ? undefined : DETAIL[kind](node)),
    id: nodeKey(id),
    kind: kind === "source" ? "input" : "step",
    label:
      override.label ??
      (typeof label === "string" && label !== "" ? label : (KIND_TITLES[kind] ?? kind)),
    nodeId: id,
    stepKind: kind,
  };
}

/**
 * The view node graph: every node of the definition (sources drawn as
 * dataset nodes), an edge from each node to every node that reads it, and the
 * output node after the result. Every edge carries the connection it stands
 * for so the editor can insert a node on it. Pure and total: malformed or
 * partial definitions produce a smaller graph, never an error.
 */
export function buildViewNodeGraph(
  definition: ViewDefinition,
  options: NodeGraphOptions = {},
): Graph {
  const nodes = looseOf(looseOf(definition)["nodes"]);
  const out: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const [id, raw] of Object.entries(nodes)) {
    const node = looseOf(raw);
    const { describeNode } = options;
    out.push(graphNode(id, node, describeNode === undefined ? undefined : describeNode(id)));
  }
  const known = new Set(Object.keys(nodes));
  for (const [id, raw] of Object.entries(nodes)) {
    for (const input of new Set(inputsOf(looseOf(raw)))) {
      if (known.has(input)) {
        edges.push({
          id: `edge:${input}>${id}`,
          insert: { source: input, target: id },
          kind: kindOf(looseOf(nodes[input])) === "source" ? "input" : "flow",
          source: nodeKey(input),
          target: nodeKey(id),
        });
      }
    }
  }
  const result = looseOf(looseOf(definition)["result"])["node"];
  out.push({ detail: options.outputDetail, id: "output", kind: "output", label: "Output" });
  if (typeof result === "string" && known.has(result)) {
    edges.push({
      id: `edge:${result}>output`,
      insert: { source: result, target: "result" },
      kind: "flow",
      source: nodeKey(result),
      target: "output",
    });
  }
  return { edges, nodes: out };
}

/** The graph node id of a definition node (for highlighting the selected one). */
export function nodeGraphId(id: string): string {
  return nodeKey(id);
}

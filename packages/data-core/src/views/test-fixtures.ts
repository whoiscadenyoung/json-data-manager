/**
 * Shared fixtures for the views tests (also reused by the Postgres sanity
 * int test). Not part of the public entry.
 */
import type {
  CompileInputMeta,
  JoinNode,
  KeyMatching,
  OutputSchema,
  ViewDefinition,
  ViewNode,
} from "./types.js";

export const STATES_ID = "11111111-1111-4111-8111-111111111111";
export const DEPLOYMENTS_ID = "22222222-2222-4222-8222-222222222222";
export const LINKS_ID = "33333333-3333-4333-8333-333333333333";

export const metas: CompileInputMeta[] = [
  {
    node: "states",
    datasetId: STATES_ID,
    title: "States",
    fields: [{ name: "id" }, { name: "name" }, { name: "stateName" }],
  },
  {
    node: "deployments",
    datasetId: DEPLOYMENTS_ID,
    title: "Deployments 2024",
    fields: [
      { name: "id" },
      { name: "name" },
      { name: "stateId", type: "string" },
      { name: "cost", type: "number" },
    ],
  },
  {
    node: "links",
    datasetId: LINKS_ID,
    title: "Links",
    pinnedVersion: "v-ref-1",
    fields: [{ name: "stateName" }, { name: "type" }, { name: "url" }],
  },
];

export const noNormalization: KeyMatching = {
  trim: false,
  caseFold: false,
  collapseSpace: false,
  stripDiacritics: false,
};

export const fullNormalization: KeyMatching = {
  trim: true,
  caseFold: true,
  collapseSpace: true,
  stripDiacritics: true,
};

export const emptyOutput: OutputSchema = { fields: [], emptyFields: "keep" };

export const sourceNodes: Record<string, ViewNode> = {
  states: { kind: "source", ref: { kind: "dataset", id: STATES_ID } },
  deployments: { kind: "source", ref: { kind: "dataset", id: DEPLOYMENTS_ID } },
  links: { kind: "source", ref: { kind: "dataset", id: LINKS_ID, version: "v-ref-1" } },
};

/** A graph of the three fixture sources plus `nodes`; the result defaults to the last of `nodes`. */
export function graph(
  nodes: Record<string, ViewNode>,
  result?: string,
  output: OutputSchema = emptyOutput,
): ViewDefinition {
  const all = { ...sourceNodes, ...nodes };
  const ids = Object.keys(nodes);
  return { nodes: all, result: { node: result ?? ids[ids.length - 1] ?? "states", output } };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A node reading only its predecessor: its main input is filled in by `chain`. */
export type ChainStep = DistributiveOmit<
  Exclude<ViewNode, { kind: "source" | "stack" }>,
  "from" | "left"
>;

/**
 * A linear chain `states -> s0 -> s1 -> ...`; `join` steps take their `right`
 * node id as given. Nodes are `s0`, `s1`, ... and the result is the last one.
 */
export function chain(steps: ChainStep[], output: OutputSchema = emptyOutput): ViewDefinition {
  const nodes: Record<string, ViewNode> = {};
  let prev = "states";
  for (const [i, step] of steps.entries()) {
    const id = `s${i}`;
    const node = (
      step.kind === "join" ? { ...step, left: prev } : { ...step, from: prev }
    ) as ViewNode;
    nodes[id] = node;
    prev = id;
  }
  return graph(nodes, prev, output);
}

/** A join over `right` (a node id) with sensible defaults; `chain` supplies `left`. */
export function join(overrides: Partial<Omit<JoinNode, "left">> = {}): Omit<JoinNode, "left"> {
  return {
    kind: "join",
    right: "deployments",
    on: [{ left: "id", right: "stateId" }],
    matching: noNormalization,
    type: "left",
    multiMatch: { mode: "first" },
    ...overrides,
  };
}

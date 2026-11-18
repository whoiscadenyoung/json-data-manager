import type { ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { LINEAGE_FIXTURE, STATES_ENRICHED } from "./fixtures";
import type { Graph, PositionedGraph } from "./graph-types";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from "./layout";
import { buildLineageGraph } from "./lineage-graph";
import { buildViewNodeGraph } from "./node-graph";
import { lineageNodeHref } from "./node-href";

function edgePairs(graph: Graph): string[] {
  return graph.edges.map((edge) => `${edge.kind}:${edge.source}>${edge.target}`).toSorted();
}

/** Ids of node pairs whose boxes overlap, plus nodes that got no position. */
function overlaps(graph: Graph, layout: PositionedGraph): string[] {
  const found: string[] = [];
  const placed = graph.nodes.flatMap((node) => {
    const position = layout.positions[node.id];
    if (position === undefined) {
      found.push(`${node.id} has no position`);
      return [];
    }
    return [{ id: node.id, x: position.x, y: position.y }];
  });
  for (const [a, first] of placed.entries()) {
    for (const second of placed.slice(a + 1)) {
      const separated =
        first.x + NODE_WIDTH <= second.x ||
        second.x + NODE_WIDTH <= first.x ||
        first.y + NODE_HEIGHT <= second.y ||
        second.y + NODE_HEIGHT <= first.y;
      if (!separated) {
        found.push(`${first.id} overlaps ${second.id}`);
      }
    }
  }
  return found;
}

function nodeById(graph: Graph, id: string) {
  return graph.nodes.find((node) => node.id === id);
}

describe("buildViewNodeGraph", () => {
  const graph = buildViewNodeGraph(STATES_ENRICHED);

  it("draws sources, nodes and the output for the design fixture", () => {
    expect(graph.nodes.map((node) => node.id).toSorted()).toEqual([
      "node:agency_counts",
      "node:deployment_agencies",
      "node:deployments",
      "node:enriched",
      "node:links",
      "node:states",
      "node:with_deployments",
      "output",
    ]);
    expect(edgePairs(graph)).toEqual([
      "flow:node:agency_counts>node:with_deployments",
      "flow:node:enriched>output",
      "flow:node:with_deployments>node:enriched",
      "input:node:deployment_agencies>node:agency_counts",
      "input:node:deployments>node:agency_counts",
      "input:node:links>node:enriched",
      "input:node:states>node:with_deployments",
    ]);
  });

  it("draws sources as dataset nodes and carries node ids", () => {
    expect(nodeById(graph, "node:states")).toMatchObject({ kind: "input", nodeId: "states" });
    expect(nodeById(graph, "node:enriched")).toMatchObject({
      detail: "Left join links",
      kind: "step",
      nodeId: "enriched",
    });
  });

  it("carries the connection every edge stands for, so a node can be inserted on it", () => {
    const inserts = graph.edges
      .flatMap((edge) =>
        edge.insert === undefined ? [] : [`${edge.insert.source}>${edge.insert.target}`],
      )
      .toSorted();
    expect(inserts).toContain("states>with_deployments");
    expect(inserts).toContain("enriched>result");
  });

  it("takes node text and badges from the editor", () => {
    const described = buildViewNodeGraph(STATES_ENRICHED, {
      describeNode: (id) =>
        id === "enriched"
          ? { badge: { label: "Needs input", tone: "neutral" }, detail: "Links", label: "Enriched" }
          : id === "states"
            ? { label: "US States" }
            : undefined,
      outputDetail: "All fields (4)",
    });
    expect(nodeById(described, "node:states")).toMatchObject({ label: "US States" });
    expect(nodeById(described, "node:enriched")).toMatchObject({
      badge: { label: "Needs input", tone: "neutral" },
      detail: "Links",
      label: "Enriched",
    });
    // A node the editor says nothing about keeps its stored label or kind title.
    expect(nodeById(described, "node:agency_counts")).toMatchObject({
      label: "Agencies per deployment",
    });
    expect(nodeById(described, "node:with_deployments")).toMatchObject({ label: "Join" });
    expect(nodeById(described, "output")).toMatchObject({ detail: "All fields (4)" });
  });

  it("renders unknown node kinds and malformed definitions without throwing", () => {
    const future = buildViewNodeGraph({
      nodes: {
        a: { kind: "source", ref: { id: "x", kind: "dataset" } },
        b: { kind: "spatialJoin", from: "a" },
        c: { nope: true },
      },
      result: { node: "b", output: { emptyFields: "keep", fields: [] } },
    } as unknown as ViewDefinition);
    const labels = future.nodes.filter((node) => node.kind === "step").map((node) => node.label);
    expect(labels).toEqual(["spatialJoin", "unknown"]);
    expect(buildViewNodeGraph({} as unknown as ViewDefinition).nodes).toHaveLength(1);
  });

  it("lays out without overlaps", async () => {
    expect(overlaps(graph, await layoutGraph(graph))).toEqual([]);
  });
});
describe("buildLineageGraph", () => {
  const graph = buildLineageGraph(LINEAGE_FIXTURE);

  it("builds nodes for every entity kind", () => {
    const kinds = new Set(graph.nodes.map((node) => node.kind));
    expect([...kinds].toSorted()).toEqual(["app", "dataset", "layer", "map", "view"]);
  });

  it("draws input, relation and consumer edges in data-flow direction", () => {
    expect(edgePairs(graph)).toEqual([
      "consumer:layer:layer-1>map:map-1",
      "consumer:map:map-1>app:app-1",
      "consumer:view:view-enriched>layer:layer-1",
      "input:dataset:ds-agencies>view:view-enriched",
      "input:dataset:ds-deployments>view:view-enriched",
      "input:dataset:ds-links>view:view-enriched",
      "input:dataset:ds-states>view:view-broken",
      "input:dataset:ds-states>view:view-enriched",
      "relation:dataset:ds-deployments>dataset:ds-agencies",
    ]);
  });

  it("marks stale and failing views", () => {
    expect(nodeById(graph, "view:view-enriched")).toMatchObject({ status: "stale" });
    expect(nodeById(graph, "view:view-broken")).toMatchObject({ status: "error" });
    expect(nodeById(graph, "dataset:ds-states")).toMatchObject({ status: undefined });
  });

  it("survives cycles, self references and unreadable datasets", async () => {
    const cyclic = buildLineageGraph({
      ...LINEAGE_FIXTURE,
      viewInputs: [
        ...LINEAGE_FIXTURE.viewInputs,
        { alias: "self", inputDatasetId: "view-enriched", viewId: "view-enriched" },
        { alias: "loop", inputDatasetId: "view-enriched", viewId: "view-broken" },
        { alias: "loop", inputDatasetId: "view-broken", viewId: "view-enriched" },
        { alias: "gone", inputDatasetId: "ds-hidden", viewId: "view-broken" },
      ],
    });
    expect(cyclic.nodes.some((node) => node.label === "Unavailable dataset")).toBe(true);
    expect(overlaps(cyclic, await layoutGraph(cyclic))).toEqual([]);
  });

  it("lays out the fixture without overlaps", async () => {
    expect(overlaps(graph, await layoutGraph(graph))).toEqual([]);
  });
});

describe("lineageNodeHref", () => {
  it("routes each openable kind and leaves layers and unreadable nodes alone", () => {
    const graph = buildLineageGraph({
      ...LINEAGE_FIXTURE,
      viewInputs: [{ alias: "x", inputDatasetId: "ds-hidden", viewId: "view-broken" }],
    });
    const href = (id: string) => {
      const node = nodeById(graph, id);
      return node === undefined ? "missing" : lineageNodeHref("p1", node);
    };
    expect(href("dataset:ds-states")).toBe("/projects/p1/datasets/ds-states");
    expect(href("view:view-enriched")).toBe("/projects/p1/views/view-enriched");
    expect(href("map:map-1")).toBe("/projects/p1/maps/map-1");
    expect(href("app:app-1")).toBe("/projects/p1/apps/app-1/edit");
    expect(href("layer:layer-1")).toBeNull();
    expect(href("dataset:ds-hidden")).toBeNull();
  });
});

describe("buildViewNodeGraph: reads", () => {
  const sources = {
    a: { kind: "source", ref: { id: "x", kind: "dataset" } },
    b: { kind: "source", ref: { id: "y", kind: "dataset" } },
    c: { kind: "source", ref: { id: "z", kind: "dataset" } },
  };

  it("draws every stacked input into the Stack node", () => {
    const stacked = {
      nodes: {
        ...sources,
        s: { kind: "stack", inputs: [{ node: "a" }, { node: "b" }, { node: "c" }] },
      },
      result: { node: "s", output: { emptyFields: "keep", fields: [] } },
    } as unknown as ViewDefinition;
    expect(edgePairs(buildViewNodeGraph(stacked))).toEqual([
      "flow:node:s>output",
      "input:node:a>node:s",
      "input:node:b>node:s",
      "input:node:c>node:s",
    ]);
  });

  it("draws SQL reads and a shared node read twice by different readers", () => {
    const def = {
      nodes: {
        ...sources,
        f: { kind: "filter", from: "a", where: { field: "x", op: "notNull" } },
        q: { kind: "sql", from: "f", reads: ["b"], query: "select * from prev, in_b" },
        j: { kind: "join", left: "f", right: "q", on: [] },
      },
      result: { node: "j", output: { emptyFields: "keep", fields: [] } },
    } as unknown as ViewDefinition;
    const pairs = edgePairs(buildViewNodeGraph(def));
    expect(pairs).toContain("input:node:b>node:q");
    expect(pairs).toContain("flow:node:f>node:q");
    expect(pairs).toContain("flow:node:f>node:j");
    expect(pairs).toContain("flow:node:q>node:j");
  });
});

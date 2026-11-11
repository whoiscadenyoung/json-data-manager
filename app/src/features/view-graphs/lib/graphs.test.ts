import type { ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { LINEAGE_FIXTURE, STATES_ENRICHED } from "./fixtures";
import type { Graph, PositionedGraph } from "./graph-types";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from "./layout";
import { buildLineageGraph } from "./lineage-graph";
import { lineageNodeHref } from "./node-href";
import { buildViewStepGraph } from "./step-graph";

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

describe("buildViewStepGraph", () => {
  const graph = buildViewStepGraph(STATES_ENRICHED);

  it("draws inputs, steps, the sub-pipeline branch and the output for the design fixture", () => {
    expect(graph.nodes.map((node) => node.id).toSorted()).toEqual([
      "input:deploymentAgencies",
      "input:deployments",
      "input:links",
      "input:states",
      "output",
      "step:0",
      "step:0.0",
      "step:1",
    ]);
    expect(edgePairs(graph)).toEqual([
      "branch:input:deploymentAgencies>step:0.0",
      "branch:input:deployments>step:0.0",
      "branch:input:links>step:1",
      "branch:step:0.0>step:0",
      "flow:input:states>step:0",
      "flow:step:0>step:1",
      "flow:step:1>output",
    ]);
  });

  it("selects steps by index and sub index", () => {
    expect(nodeById(graph, "step:0")).toMatchObject({ step: { index: 0 } });
    expect(nodeById(graph, "step:0.0")).toMatchObject({ step: { index: 0, sub: 0 } });
    expect(nodeById(graph, "step:1")).toMatchObject({ detail: "Left join links" });
  });

  it("renders unknown step kinds and malformed definitions without throwing", () => {
    const future = buildViewStepGraph({
      base: "states",
      inputs: [{ alias: "states", ref: { id: "x", kind: "dataset" } }],
      output: { emptyFields: "keep", fields: [] },
      steps: [{ kind: "spatialJoin" }, { nope: true }],
    } as unknown as ViewDefinition);
    const labels = future.nodes.filter((node) => node.kind === "step").map((node) => node.label);
    expect(labels).toEqual(["spatialJoin", "unknown"]);
    expect(buildViewStepGraph({} as unknown as ViewDefinition).nodes).toHaveLength(1);
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

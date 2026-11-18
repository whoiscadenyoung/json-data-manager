import { describe, expect, test } from "vitest";

import { dependencyOrder, findCycle, reachableIds, readersOf } from "./graph.js";
import {
  canExtract,
  freshNodeId,
  nodeLabelOfPath,
  nodeUsages,
  planExtract,
  pruneNodes,
  remapReport,
  remapSources,
  renameNodeId,
  unusedNodeIds,
} from "./reuse.js";
import { must } from "./test-fixtures-pglite.js";
import { graph, join, metas } from "./test-fixtures.js";
import type { ViewDefinition, ViewNode } from "./types.js";

const clean: ViewNode = {
  kind: "calculate",
  from: "deployments",
  fields: [{ field: "x", expr: "cost * 2" }],
};

function sample(): ViewDefinition {
  return graph(
    {
      clean,
      joined: { ...join({ right: "clean" }), left: "states" },
      stray: { kind: "filter", from: "links", where: { field: "url", op: "notNull" } },
    },
    "joined",
  );
}

describe("graph helpers", () => {
  test("dependency order lists dependencies first and skips unreachable nodes", () => {
    const def = sample();
    const order = dependencyOrder(def.nodes, "joined");
    expect(order).toEqual({ ok: true, order: ["states", "deployments", "clean", "joined"] });
    expect(reachableIds(def).has("stray")).toBe(false);
    expect(unusedNodeIds(def).toSorted()).toEqual(["links", "stray"]);
  });

  test("cycles and missing nodes", () => {
    const nodes: Record<string, ViewNode> = {
      a: { kind: "filter", from: "b", where: { field: "x", op: "notNull" } },
      b: { kind: "filter", from: "a", where: { field: "x", op: "notNull" } },
    };
    expect(findCycle(nodes)).toEqual(["a", "b", "a"]);
    expect(dependencyOrder(nodes, "a")).toEqual({ ok: false, cycle: ["a", "b", "a"] });
    expect(dependencyOrder({ a: nodes.a }, "a")).toEqual({
      ok: false,
      missing: "b",
      reader: "a",
    });
  });

  test("readers and usages include the result", () => {
    const def = sample();
    expect(readersOf(def).get("deployments")).toEqual(["clean"]);
    expect(must(nodeUsages(def).get("joined")).map((u) => u.label)).toEqual(["Result"]);
    expect(must(nodeUsages(def).get("clean")).map((u) => u.node)).toEqual(["joined"]);
  });
});

describe("reuse", () => {
  test("renameNodeId rewrites every reference, including sql reads", () => {
    const def = graph(
      {
        q: {
          kind: "sql",
          from: "states",
          reads: ["deployments"],
          query: "select * from prev, in_deployments",
        },
      },
      "q",
    );
    const next = renameNodeId(def, "deployments", "deps");
    expect(Object.keys(next.nodes)).toContain("deps");
    expect(next.nodes.q).toMatchObject({ reads: ["deps"], query: "select * from prev, in_deps" });
    const joined = renameNodeId(sample(), "clean", "tidy");
    expect(joined.nodes.joined).toMatchObject({ right: "tidy" });
  });

  test("pruneNodes drops unreachable nodes", () => {
    expect(Object.keys(pruneNodes(sample()).nodes).toSorted()).toEqual([
      "clean",
      "deployments",
      "joined",
      "states",
    ]);
  });

  test("freshNodeId is a readable slug", () => {
    expect(freshNodeId("Clean D1", ["states"])).toBe("clean_d1");
    expect(freshNodeId("states", ["states"])).toBe("states_2");
  });

  test("remapSources re-points a source, drops its version and pins the join prefix", () => {
    const def = graph({ joined: { ...join({ right: "links" }), left: "states" } }, "joined");
    const next = remapSources(def, [{ node: "links", datasetId: "new-id", oldTitle: "Link list" }]);
    expect(next.nodes.links).toEqual({ kind: "source", ref: { kind: "dataset", id: "new-id" } });
    expect(next.nodes.joined).toMatchObject({ prefix: "link_list" });
    expect(def.nodes.links).toMatchObject({ ref: { version: "v-ref-1" } });
  });

  test("remapReport groups problems per node", () => {
    const def = graph({
      f: { kind: "filter", from: "states", where: { field: "ghost", op: "notNull" } },
    });
    const report = remapReport(def, metas);
    expect(report.ok).toBe(false);
    expect(report.ok ? [] : report.byNode).toEqual([
      { node: "f", messages: ['Unknown field "ghost".'] },
    ]);
    expect(nodeLabelOfPath("nodes.f.where.field")).toBe("f");
    expect(nodeLabelOfPath("result.output")).toBe("Output");
  });

  test("planExtract takes the ancestor subgraph; a source cannot be extracted", () => {
    const def = sample();
    expect(canExtract(def, "states")).toBe(false);
    expect(canExtract(def, "clean")).toBe(true);
    const planned = planExtract(def, "clean");
    const view = planned.ok ? planned.plan.view : undefined;
    expect(Object.keys(must(view).nodes).toSorted()).toEqual(["clean", "deployments"]);
    expect(must(view).result.node).toBe("clean");
    expect(planExtract(def, "states").ok).toBe(false);
  });
});

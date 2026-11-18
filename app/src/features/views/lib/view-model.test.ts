import { validateViewDefinition } from "@caden/data-core/views";
import type { JoinNode, ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { nodeDiagnosticsOf } from "./diagnostics";
import {
  appendNode,
  blankDefinitionOf,
  definitionFromRelation,
  fieldNamesByNode,
  filterLeaves,
  filterValue,
  filterValueText,
  firstProblem,
  inputRefsOf,
  insertOnEdge,
  leavesToWhere,
  newNode,
  nodeLabel,
  nodeProblem,
  nodeSummary,
  outlineOrder,
  removeBlocker,
  removeNode,
  subgraphOf,
  toCompileMeta,
  uniqueNodeId,
  validationSummary,
  withAddedSource,
  withManualMapEntry,
  withoutManualMapEntry,
  type InputInfo,
} from "./view-model";

const STATES = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENTS = "22222222-2222-4222-8222-222222222222";

const infos: InputInfo[] = [
  { alias: "states", datasetId: STATES, title: "States", fields: ["id", "name"] },
  {
    alias: "deployments_2024",
    datasetId: DEPLOYMENTS,
    title: "Deployments 2024",
    fields: ["id", "stateId", "cost"],
  },
];

function joinNode(overrides: Partial<JoinNode> = {}): JoinNode {
  return {
    ...(newNode("join", "states", "id") as JoinNode),
    right: "deployments_2024",
    on: [{ left: "id", right: "stateId" }],
    prefix: "deployments_2024",
    ...overrides,
  };
}

/** states + deployments sources, a join, then a filter as the result. */
function graph(): ViewDefinition {
  const base = blankDefinitionOf(
    [
      { datasetId: STATES, title: "States" },
      { datasetId: DEPLOYMENTS, title: "Deployments 2024" },
    ],
    STATES,
  );
  const joined = { ...base, nodes: { ...base.nodes, joined: joinNode() } };
  return appendNode(
    { ...joined, result: { ...joined.result, node: "joined" } },
    "joined",
    "filter",
    "id",
  ).definition;
}

describe("definitionFromRelation (create view from relation)", () => {
  const seed = {
    cardinality: "1-N" as const,
    fromDataset: STATES,
    fromKey: "id",
    fromTitle: "States",
    toDataset: DEPLOYMENTS,
    toKey: "stateId",
    toTitle: "Deployments 2024",
  };

  it("pre-fills two sources, one join node and the relation's keys, titled after both datasets", () => {
    const { definition, title } = definitionFromRelation(seed);
    expect(title).toBe("States + Deployments 2024");
    expect(Object.keys(definition.nodes)).toStrictEqual(["states", "deployments_2024", "joined"]);
    expect(definition.result.node).toBe("joined");
    expect(definition.nodes.joined).toMatchObject({
      kind: "join",
      left: "states",
      on: [{ left: "id", right: "stateId" }],
      right: "deployments_2024",
      type: "left",
    });
  });

  it("summarizes with a count for a one-to-many relation (no row is dropped or multiplied)", () => {
    const { definition } = definitionFromRelation(seed);
    expect(definition.nodes.joined).toMatchObject({
      multiMatch: { mode: "summarize", measures: [{ as: "deployments_2024_count", fn: "count" }] },
    });
  });

  it("takes the first match, with a title prefix, for a one-to-one relation", () => {
    const { definition } = definitionFromRelation({ ...seed, cardinality: "1-1" });
    expect(definition.nodes.joined).toMatchObject({
      multiMatch: { mode: "first" },
      prefix: "deployments_2024",
    });
  });

  it("validates against the sources' declared fields", () => {
    const { definition } = definitionFromRelation(seed);
    expect(validateViewDefinition(definition, toCompileMeta(infos)).ok).toBe(true);
  });

  it("keeps node ids unique when both sides share a title", () => {
    const { definition } = definitionFromRelation({ ...seed, toTitle: "States" });
    expect(new Set(Object.keys(definition.nodes)).size).toBe(3);
  });
});

describe("field scope", () => {
  it("starts from a source's declared fields and flows through nodes", () => {
    const fields = fieldNamesByNode(graph(), infos);
    expect(fields.get("states")).toStrictEqual(["id", "name"]);
    expect(fields.get("joined")).toStrictEqual([
      "id",
      "name",
      "deployments_2024.id",
      "deployments_2024.stateId",
      "deployments_2024.cost",
    ]);
    expect(fields.get("filter_rows")).toStrictEqual(fields.get("joined"));
  });

  it("adds only the measures' names for a summarize join", () => {
    const def = graph();
    const summarized: ViewDefinition = {
      ...def,
      nodes: {
        ...def.nodes,
        joined: joinNode({
          multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
        }),
      },
    };
    expect(fieldNamesByNode(summarized, infos).get("joined")).toStrictEqual(["id", "name", "n"]);
  });

  it("applies a stack input's column edits and a group-by's new shape", () => {
    const base = blankDefinitionOf([
      { datasetId: STATES, title: "States" },
      { datasetId: DEPLOYMENTS, title: "Deployments 2024" },
    ]);
    const def: ViewDefinition = {
      ...base,
      nodes: {
        ...base.nodes,
        stacked: {
          kind: "stack",
          inputs: [
            { node: "states", columns: [{ from: "name", exclude: true }] },
            {
              node: "deployments_2024",
              columns: [
                { from: "cost", as: "amount" },
                { from: "stateId", exclude: true },
              ],
            },
          ],
        },
        grouped: {
          kind: "groupBy",
          from: "stacked",
          by: ["id"],
          measures: [{ as: "n", fn: "count" }],
        },
      },
    };
    const fields = fieldNamesByNode(def, infos);
    expect(fields.get("stacked")).toStrictEqual(["id", "amount"]);
    expect(fields.get("grouped")).toStrictEqual(["id", "n"]);
  });
});

describe("graph editing", () => {
  it("appending after the result moves the result; a branch leaves it", () => {
    const base = blankDefinitionOf([{ datasetId: STATES, title: "States" }]);
    const appended = appendNode(base, "states", "calculate", "id");
    expect(appended.definition.result.node).toBe(appended.node);
    expect(appended.definition.nodes[appended.node]).toMatchObject({
      kind: "calculate",
      from: "states",
    });
    const branched = appendNode(appended.definition, "states", "filter", "id");
    expect(branched.definition.result.node).toBe(appended.node);
    expect(Object.keys(branched.definition.nodes)).toHaveLength(3);
  });

  it("inserting on a connection splits it", () => {
    const def = graph();
    const inserted = insertOnEdge(def, "states", "joined", "columns", "id");
    expect(inserted.definition.nodes[inserted.node]).toMatchObject({
      kind: "columns",
      from: "states",
    });
    expect(inserted.definition.nodes.joined).toMatchObject({ left: inserted.node });
    const intoOutput = insertOnEdge(def, "filter_rows", "result", "calculate", "id");
    expect(intoOutput.definition.result.node).toBe(intoOutput.node);
  });

  it("removing a node reconnects its readers and the result", () => {
    const def = graph();
    const without = removeNode(def, "filter_rows");
    expect(without.result.node).toBe("joined");
    const mid = removeNode(def, "joined");
    // The join has two inputs, so it can't be removed while read.
    expect(removeBlocker(def, "joined")).toMatch(/Used by filter_rows/);
    expect(mid.nodes.filter_rows).toBeDefined();
    const single = insertOnEdge(def, "states", "joined", "columns", "id");
    expect(removeBlocker(single.definition, single.node)).toBeUndefined();
    expect(removeNode(single.definition, single.node).nodes.joined).toMatchObject({
      left: "states",
    });
    expect(removeBlocker(def, "filter_rows")).toBeUndefined();
  });

  it("subgraphOf keeps only what a node reads, and the outline lists dependencies first", () => {
    const def = graph();
    const sub = subgraphOf(def, "joined");
    expect(Object.keys(sub.nodes).toSorted()).toStrictEqual([
      "deployments_2024",
      "joined",
      "states",
    ]);
    expect(sub.result.node).toBe("joined");
    expect(outlineOrder(def)).toStrictEqual([
      "states",
      "deployments_2024",
      "joined",
      "filter_rows",
    ]);
    const stray = appendNode(def, "states", "sql", "id");
    expect(outlineOrder(stray.definition).at(-1)).toBe(stray.node);
  });

  it("adds a source with a fresh id", () => {
    const base = blankDefinitionOf([{ datasetId: STATES, title: "States" }]);
    const added = withAddedSource(base, { id: STATES, title: "States" });
    expect(added.node).toBe("states_2");
    expect(inputRefsOf(added.definition)).toStrictEqual([
      { alias: "states", datasetId: STATES },
      { alias: "states_2", datasetId: STATES },
    ]);
  });

  it("labels and summarizes nodes", () => {
    const def = graph();
    expect(nodeLabel(def, infos, "states")).toBe("States");
    expect(nodeLabel(def, infos, "filter_rows")).toBe("Filter rows");
    expect(nodeSummary(def, infos, "joined")).toMatch(
      /States \+ Deployments 2024 \(left, first match\)/,
    );
  });
});

describe("join editing helpers", () => {
  it("adds, replaces and removes manual key-map entries", () => {
    const first = withManualMapEntry(joinNode(), "Alabama ", "Alabama");
    expect(first.matching.manualMap).toStrictEqual([{ from: "Alabama ", to: "Alabama" }]);
    const replaced = withManualMapEntry(first, "Alabama ", "AL");
    expect(replaced.matching.manualMap).toStrictEqual([{ from: "Alabama ", to: "AL" }]);
    const cleared = withoutManualMapEntry(replaced, "Alabama ");
    expect(cleared.matching.manualMap).toBeUndefined();
  });

  it("flags incomplete nodes with a reason", () => {
    expect(nodeProblem(newNode("join", "states", "id"))).toMatch(/two nodes/);
    expect(nodeProblem(joinNode({ on: [{ left: "id", right: "" }] }))).toMatch(/key fields/);
    expect(nodeProblem(joinNode())).toBeUndefined();
    expect(nodeProblem(newNode("calculate", "states", "id"))).toMatch(/Name every new field/);
    expect(nodeProblem(newNode("stack", "states", "id"))).toMatch(/every node to stack/);
    expect(firstProblem(graph(), ["states", "joined"])).toBeUndefined();
  });
});

describe("filter helpers", () => {
  it("round-trips one leaf and an AND of leaves", () => {
    const leaf = { field: "cost", op: "gt" as const, value: 10 };
    expect(leavesToWhere([leaf])).toStrictEqual(leaf);
    expect(leavesToWhere([leaf, leaf])).toStrictEqual({ and: [leaf, leaf] });
    expect(filterLeaves({ and: [leaf, leaf] })).toHaveLength(2);
    expect(filterLeaves({ or: [leaf] })).toBeUndefined();
  });

  it("types values as the user wrote them", () => {
    expect(filterValue("eq", "12")).toBe(12);
    expect(filterValue("eq", "Kansas")).toBe("Kansas");
    expect(filterValue("in", "1, b, 3")).toStrictEqual([1, "b", 3]);
    expect(filterValue("isNull", "x")).toBeUndefined();
    expect(filterValueText({ field: "a", op: "in", value: [1, "b"] })).toBe("1, b");
  });
});

describe("inputs", () => {
  it("builds a blank definition over datasets, the chosen base as the result", () => {
    const def = blankDefinitionOf(
      [
        { datasetId: STATES, title: "States" },
        { datasetId: DEPLOYMENTS, title: "Deployments" },
      ],
      DEPLOYMENTS,
    );
    expect(Object.keys(def.nodes)).toStrictEqual(["states", "deployments"]);
    expect(def.result.node).toBe("deployments");
  });

  it("keeps ids unique and readable", () => {
    expect(uniqueNodeId("States", ["states"])).toBe("states_2");
    expect(uniqueNodeId("", [])).toBe("input");
  });

  it("derives the saved sources from the source nodes", () => {
    expect(inputRefsOf(graph())).toStrictEqual([
      { alias: "states", datasetId: STATES },
      { alias: "deployments_2024", datasetId: DEPLOYMENTS },
    ]);
  });

  it("summarizes validation problems with a count of the rest", () => {
    expect(validationSummary([{ message: "A" }, { message: "B" }, { message: "C" }])).toBe(
      "A (and 2 more)",
    );
    expect(validationSummary([{ message: "A" }])).toBe("A");
  });
});

describe("nodeDiagnosticsOf", () => {
  const payload = {
    nodes: [
      {
        id: "j",
        kind: "join",
        rowsIn: 50,
        rowsOut: "50",
        fieldsAdded: ["deployments"],
        fieldsRemoved: [],
        join: {
          leftMatched: 48,
          leftUnmatched: 2,
          leftUnmatchedSamples: ["Alabama "],
          rightMatched: 100,
          rightUnmatched: 3,
          rightUnmatchedSamples: ["alabama"],
          multiMatchKeys: 40,
          policy: "summarize",
        },
      },
    ],
  };

  it("reads the diagnostics contract, coercing counts", () => {
    const node = nodeDiagnosticsOf(payload, "j");
    expect(node).toMatchObject({ rowsIn: 50, rowsOut: 50 });
    expect(
      node === undefined || node.join === undefined ? [] : node.join.leftUnmatchedSamples,
    ).toStrictEqual(["Alabama "]);
  });

  it("reads a missing or malformed payload as no diagnostics", () => {
    expect(nodeDiagnosticsOf(payload, "gone")).toBeUndefined();
    expect(nodeDiagnosticsOf({ nope: true }, "j")).toBeUndefined();
    expect(nodeDiagnosticsOf(null, "j")).toBeUndefined();
  });
});

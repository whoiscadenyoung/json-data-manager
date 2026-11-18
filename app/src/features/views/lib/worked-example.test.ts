import { compileView, validateViewDefinition } from "@caden/data-core/views";
import type { JoinNode, ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { nodeDiagnosticsOf } from "./diagnostics";
import {
  appendNode,
  blankDefinitionOf,
  fieldNamesByNode,
  firstProblem,
  newNode,
  proposeSpreadColumns,
  repointRight,
  toCompileMeta,
  type InputInfo,
} from "./view-model";

const STATES = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENTS = "22222222-2222-4222-8222-222222222222";
const AGENCIES = "33333333-3333-4333-8333-333333333333";
const LINKS = "44444444-4444-4444-8444-444444444444";

const datasets = [
  { id: STATES, title: "States", fields: ["id", "name"] },
  { id: DEPLOYMENTS, title: "Deployments", fields: ["id", "name", "stateId"] },
  { id: AGENCIES, title: "Deployment agencies", fields: ["deploymentId", "agencyId"] },
  { id: LINKS, title: "Links", fields: ["stateName", "type", "url"] },
];

function infosOf(definition: ViewDefinition): InputInfo[] {
  return Object.entries(definition.nodes).flatMap(([id, node]) => {
    if (node.kind !== "source") {
      return [];
    }
    const found = datasets.find((d) => d.id === node.ref.id);
    return [
      {
        alias: id,
        datasetId: node.ref.id,
        title: found === undefined ? "" : found.title,
        fields: found === undefined ? [] : found.fields,
      },
    ];
  });
}

function asJoin(node: ViewDefinition["nodes"][string] | undefined): JoinNode {
  if (node === undefined || node.kind !== "join") {
    throw new Error("expected a join node");
  }
  return node;
}

/** Add a join node reading `left` and `right`, built the way the editor builds one (repointRight fills the prefix). */
function addJoin(
  definition: ViewDefinition,
  id: string,
  left: string,
  right: string,
  rightTitle: string,
  build: (node: JoinNode) => JoinNode,
): ViewDefinition {
  const blank = asJoin(newNode("join", left, "id"));
  const node = build(repointRight(blank, right, { old: "", next: rightTitle }));
  return { ...definition, nodes: { ...definition.nodes, [id]: node } };
}

/** Design §5 ("States enriched"), assembled only from the editor's node model. */
function buildWalkthrough(): ViewDefinition {
  let def = blankDefinitionOf([
    { datasetId: STATES, title: "States" },
    { datasetId: DEPLOYMENTS, title: "Deployments" },
    { datasetId: AGENCIES, title: "Deployment agencies" },
    { datasetId: LINKS, title: "Links" },
  ]);
  // Count agencies per deployment first, as its own node.
  def = addJoin(
    def,
    "agency_counts",
    "deployments",
    "deployment_agencies",
    "Deployment agencies",
    (node) => ({
      ...node,
      on: [{ left: "id", right: "deploymentId" }],
      multiMatch: { mode: "summarize", measures: [{ as: "agencyCount", fn: "count" }] },
    }),
  );
  // Join that onto the states.
  def = addJoin(def, "with_deployments", "states", "agency_counts", "Deployments", (node) => ({
    ...node,
    on: [{ left: "id", right: "stateId" }],
    multiMatch: {
      mode: "summarize",
      measures: [
        { as: "deployments", fn: "count", emptyValue: 0 },
        {
          as: "mostCollaboration",
          fn: "topBy",
          field: "name",
          by: "agencyCount",
          direction: "max",
        },
      ],
    },
  }));
  // Join links, one column per link type.
  def = addJoin(def, "enriched", "with_deployments", "links", "Links", (node) => ({
    ...node,
    on: [{ left: "name", right: "stateName" }],
    matching: { ...node.matching, caseFold: true },
    multiMatch: {
      mode: "spread",
      by: "type",
      value: "url",
      columns: proposeSpreadColumns(["docs", "benefits"], [], []).map((c) => ({
        category: c.category,
        as: `${c.as}Link`,
      })),
    },
  }));
  const final = fieldNamesByNode(def, infosOf(def)).get("enriched") ?? [];
  return {
    ...def,
    result: {
      node: "enriched",
      output: {
        fields: ["name", "deployments", "mostCollaboration", "docsLink", "benefitsLink"]
          .filter((key) => final.includes(key))
          .map((key) => ({ key })),
        emptyFields: "omit",
      },
    },
  };
}

describe("design §5 walkthrough through the node model", () => {
  const def = buildWalkthrough();
  const infos = infosOf(def);

  it("builds a definition the real validator accepts", () => {
    const result = validateViewDefinition(def, toCompileMeta(infos));
    expect(result).toMatchObject({ ok: true });
    expect(firstProblem(def, Object.keys(def.nodes))).toBeUndefined();
  });

  it("tracks the fields of every node, through the counted node and the new modes", () => {
    const fields = fieldNamesByNode(def, infos);
    expect(fields.get("agency_counts")).toEqual(["id", "name", "stateId", "agencyCount"]);
    expect(fields.get("with_deployments")).toEqual([
      "id",
      "name",
      "deployments",
      "mostCollaboration",
    ]);
    expect(fields.get("enriched")).toEqual([
      "id",
      "name",
      "deployments",
      "mostCollaboration",
      "docsLink",
      "benefitsLink",
    ]);
    expect(def.result.output.fields.map((f) => f.key)).toEqual([
      "name",
      "deployments",
      "mostCollaboration",
      "docsLink",
      "benefitsLink",
    ]);
  });

  it("compiles", () => {
    expect(compileView(def, toCompileMeta(infos)).sql.length).toBeGreaterThan(100);
  });

  it("rejects a definition whose upstream node removed the join key", () => {
    const grouped = appendNode(def, "agency_counts", "groupBy", "id");
    const broken: ViewDefinition = {
      ...grouped.definition,
      nodes: {
        ...grouped.definition.nodes,
        with_deployments: { ...asJoin(def.nodes.with_deployments), right: grouped.node },
      },
    };
    const result = validateViewDefinition(broken, toCompileMeta(infos));
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ path: "nodes.with_deployments.on[0].right" }),
      ]),
    });
  });
});

describe("advanced node helpers", () => {
  it("proposes spread columns from values, skipping declared ones and keeping names unique", () => {
    expect(
      proposeSpreadColumns(
        ["docs", "Press Kit", "press-kit", ""],
        [{ category: "docs", as: "docsLink" }],
        ["name"],
      ),
    ).toEqual([
      { category: "Press Kit", as: "PressKit" },
      { category: "press-kit", as: "pressKit" },
    ]);
  });

  it("finds node diagnostics by id", () => {
    const payload = {
      nodes: [
        { id: "g", kind: "groupBy", rowsIn: 9, rowsOut: 3, fieldsAdded: [], fieldsRemoved: [] },
        { id: "j", kind: "join", rowsIn: 1, rowsOut: 1, fieldsAdded: [], fieldsRemoved: [] },
      ],
    };
    expect(nodeDiagnosticsOf(payload, "j")).toMatchObject({ kind: "join" });
    expect(nodeDiagnosticsOf(payload, "g")).toMatchObject({ rowsIn: 9 });
  });
});

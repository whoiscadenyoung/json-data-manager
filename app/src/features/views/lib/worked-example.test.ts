import { compileView, validateViewDefinition } from "@caden/data-core/views";
import type { JoinStep, Step, ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { stepDiagnosticsOf } from "./diagnostics";
import {
  blankDefinition,
  fieldsAfter,
  newCalculateStep,
  newJoinStep,
  newSqlStep,
  prunedInputs,
  proposeSpreadColumns,
  repointRight,
  rightFieldsOf,
  stepProblem,
  toCompileMeta,
  uniqueAlias,
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

function titleOfDataset(datasetId: string): string {
  const found = datasets.find((d) => d.id === datasetId);
  return found === undefined ? "" : found.title;
}

function asJoin(step: Step | undefined): JoinStep {
  if (step === undefined || step.kind !== "join") {
    throw new Error("expected a join step");
  }
  return step;
}

/** The editor's input-metadata step: a dataset becomes a declared input with a readable alias. */
function declare(
  definition: ViewDefinition,
  datasetId: string,
): { def: ViewDefinition; alias: string } {
  const existing = definition.inputs.find((input) => input.ref.id === datasetId);
  if (existing !== undefined) {
    return { def: definition, alias: existing.alias };
  }
  const title = titleOfDataset(datasetId);
  const alias = uniqueAlias(
    title,
    definition.inputs.map((input) => input.alias),
  );
  return {
    alias,
    def: {
      ...definition,
      inputs: [...definition.inputs, { alias, ref: { kind: "dataset", id: datasetId } }],
    },
  };
}

function infosOf(definition: ViewDefinition): InputInfo[] {
  return definition.inputs.map((input) => {
    const found = datasets.find((d) => d.id === input.ref.id);
    return {
      alias: input.alias,
      datasetId: input.ref.id,
      title: found === undefined ? "" : found.title,
      fields: found === undefined ? [] : found.fields,
    };
  });
}

function addJoin(
  definition: ViewDefinition,
  datasetId: string,
  build: (step: JoinStep) => JoinStep,
): ViewDefinition {
  const declared = declare(definition, datasetId);
  const title = titleOfDataset(datasetId);
  const step = build(
    repointRight(newJoinStep({ rightAlias: "", rightTitle: "" }), declared.alias, {
      old: "",
      next: title,
    }),
  );
  return { ...declared.def, steps: [...declared.def.steps, step] };
}

/** Design §5 ("States enriched"), assembled only from the editor's step model. */
function buildWalkthrough(): ViewDefinition {
  let def = blankDefinition({ datasetId: STATES, title: "States" });
  // Step 1: join deployments, whose right side first counts agencies per deployment.
  const withAgencies = declare(def, DEPLOYMENTS);
  def = withAgencies.def;
  const agencies = declare(def, AGENCIES);
  def = agencies.def;
  def = addJoin(def, DEPLOYMENTS, (step) => ({
    ...step,
    on: [{ left: "id", right: "stateId" }],
    right: {
      input: withAgencies.alias,
      steps: [
        {
          ...repointRight(newJoinStep({ rightAlias: "", rightTitle: "" }), agencies.alias, {
            old: "",
            next: "Deployment agencies",
          }),
          on: [{ left: "id", right: "deploymentId" }],
          multiMatch: { mode: "summarize", measures: [{ as: "agencyCount", fn: "count" }] },
        },
      ],
    },
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
  // Step 2: join links, one column per link type.
  def = addJoin(def, LINKS, (step) => ({
    ...step,
    on: [{ left: "name", right: "stateName" }],
    matching: { ...step.matching, caseFold: true },
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
  // Output fields.
  const final = fieldsAfter(def, infosOf(def), def.steps.length - 1) ?? [];
  return {
    ...def,
    output: {
      fields: ["name", "deployments", "mostCollaboration", "docsLink", "benefitsLink"]
        .filter((key) => final.includes(key))
        .map((key) => ({ key })),
      emptyFields: "omit",
    },
  };
}

describe("design §5 walkthrough through the step model", () => {
  const def = buildWalkthrough();
  const infos = infosOf(def);

  it("builds a definition the real validator accepts", () => {
    const result = validateViewDefinition(def, toCompileMeta(infos));
    expect(result).toMatchObject({ ok: true });
    expect(def.steps.map(stepProblem)).toEqual([undefined, undefined]);
  });

  it("tracks the fields after each step, through the sub-pipeline and the new modes", () => {
    const [join] = def.steps;
    expect(join).toMatchObject({ kind: "join" });
    expect(rightFieldsOf(asJoin(join), infos)).toEqual(["id", "name", "stateId", "agencyCount"]);
    expect(fieldsAfter(def, infos, 0)).toEqual(["id", "name", "deployments", "mostCollaboration"]);
    expect(fieldsAfter(def, infos, 1)).toEqual([
      "id",
      "name",
      "deployments",
      "mostCollaboration",
      "docsLink",
      "benefitsLink",
    ]);
    expect(def.output.fields.map((f) => f.key)).toEqual([
      "name",
      "deployments",
      "mostCollaboration",
      "docsLink",
      "benefitsLink",
    ]);
  });

  it("compiles, and keeps the nested join's input declared when saving", () => {
    const compiled = compileView(def, toCompileMeta(infos));
    expect(compiled.sql.length).toBeGreaterThan(100);
    const pruned = prunedInputs(def);
    expect(pruned.inputs.map((input) => input.alias)).toEqual([
      "states",
      "deployments",
      "deployment_agencies",
      "links",
    ]);
  });

  it("rejects a definition whose nested step removed the join key", () => {
    const [join] = def.steps;
    const joinStep = asJoin(join);
    const grouped: Step = { kind: "groupBy", by: ["id"], measures: [{ as: "n", fn: "count" }] };
    const broken: ViewDefinition = {
      ...def,
      steps: [
        { ...joinStep, right: { ...joinStep.right, steps: [grouped] } },
        ...def.steps.slice(1),
      ],
    };
    const result = validateViewDefinition(broken, toCompileMeta(infos));
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "steps[0].on[0].right" })]),
    });
  });
});

describe("advanced step helpers", () => {
  it("reports an incomplete calculate, sql, spread and topBy as needing input", () => {
    expect(stepProblem(newCalculateStep())).toMatch(/Name the new field/);
    expect(stepProblem({ kind: "calculate", field: "x", expr: " " })).toMatch(/expression/);
    expect(stepProblem({ kind: "sql", query: "" })).toMatch(/SQL/);
    expect(stepProblem(newSqlStep())).toBeUndefined();
    const join = newJoinStep({ rightAlias: "links", rightTitle: "Links", left: "a", right: "b" });
    expect(
      stepProblem({ ...join, multiMatch: { mode: "spread", by: "", value: "", columns: [] } }),
    ).toMatch(/category field/);
    expect(
      stepProblem({
        ...join,
        multiMatch: { mode: "summarize", measures: [{ as: "top", fn: "topBy", field: "name" }] },
      }),
    ).toMatch(/ranks the rows/);
  });

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

  it("finds sub-pipeline diagnostics by path, not by their local index", () => {
    const payload = {
      steps: [
        {
          index: 0,
          path: "steps[0].right.steps[0]",
          kind: "groupBy",
          rowsIn: 9,
          rowsOut: 3,
          fieldsAdded: [],
          fieldsRemoved: [],
        },
        { index: 0, kind: "join", rowsIn: 1, rowsOut: 1, fieldsAdded: [], fieldsRemoved: [] },
      ],
    };
    expect(stepDiagnosticsOf(payload, 0)).toMatchObject({ kind: "join" });
    expect(stepDiagnosticsOf(payload, 0, "steps[0].right.steps[0]")).toMatchObject({ rowsIn: 9 });
  });
});

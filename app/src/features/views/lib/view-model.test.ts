import { validateViewDefinition } from "@caden/data-core/views";
import type { JoinStep, ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { stepDiagnosticsOf } from "./diagnostics";
import {
  blankDefinition,
  definitionFromRelation,
  fieldsAfter,
  filterLeaves,
  filterValue,
  filterValueText,
  inputRefsOf,
  leavesToWhere,
  newJoinStep,
  prunedInputs,
  stepProblem,
  toCompileMeta,
  uniqueAlias,
  validationSummary,
  withManualMapEntry,
  withoutManualMapEntry,
  type InputInfo,
} from "./view-model";

const STATES = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENTS = "22222222-2222-4222-8222-222222222222";

const infos: InputInfo[] = [
  { alias: "states", datasetId: STATES, title: "States", fields: ["id", "name"] },
  {
    alias: "deployments",
    datasetId: DEPLOYMENTS,
    title: "Deployments 2024",
    fields: ["id", "stateId", "cost"],
  },
];

function joinStep(overrides: Partial<JoinStep> = {}): JoinStep {
  return {
    ...newJoinStep({
      rightAlias: "deployments",
      rightTitle: "Deployments 2024",
      left: "id",
      right: "stateId",
    }),
    ...overrides,
  };
}

function definitionWith(step: JoinStep): ViewDefinition {
  return {
    inputs: [
      { alias: "states", ref: { kind: "dataset", id: STATES } },
      { alias: "deployments", ref: { kind: "dataset", id: DEPLOYMENTS } },
    ],
    base: "states",
    steps: [step],
    output: { fields: [], emptyFields: "keep" },
  };
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

  it("pre-fills the base, one Join step and the relation's keys, titled after both datasets", () => {
    const { definition, title } = definitionFromRelation(seed);
    expect(title).toBe("States + Deployments 2024");
    expect(definition.base).toBe("states");
    expect(definition.inputs.map((input) => input.ref.id)).toStrictEqual([STATES, DEPLOYMENTS]);
    const [step] = definition.steps;
    expect(step).toMatchObject({
      kind: "join",
      on: [{ left: "id", right: "stateId" }],
      right: { input: "deployments_2024" },
      type: "left",
    });
  });

  it("summarizes with a count for a one-to-many relation (no row is dropped or multiplied)", () => {
    const { definition } = definitionFromRelation(seed);
    const [step] = definition.steps;
    expect(step).toMatchObject({
      multiMatch: { mode: "summarize", measures: [{ as: "deployments_2024_count", fn: "count" }] },
    });
  });

  it("takes the first match, with a title prefix, for a one-to-one relation", () => {
    const { definition } = definitionFromRelation({ ...seed, cardinality: "1-1" });
    expect(definition.steps[0]).toMatchObject({
      multiMatch: { mode: "first" },
      prefix: "deployments_2024",
    });
  });

  it("validates against the inputs' declared fields", () => {
    const { definition } = definitionFromRelation(seed);
    expect(validateViewDefinition(definition, toCompileMeta(infos)).ok).toBe(true);
  });

  it("keeps aliases unique when both sides share a title", () => {
    const { definition } = definitionFromRelation({ ...seed, toTitle: "States" });
    expect(new Set(definition.inputs.map((input) => input.alias)).size).toBe(2);
  });
});

describe("fieldsAfter", () => {
  it("starts from the base input's declared fields", () => {
    const def = definitionWith(joinStep());
    expect(fieldsAfter(def, infos, -1)).toStrictEqual(["id", "name"]);
  });

  it("adds a first-match join's fields under the title-slug prefix", () => {
    const def = definitionWith(joinStep());
    expect(fieldsAfter(def, infos, 0)).toStrictEqual([
      "id",
      "name",
      "deployments_2024.id",
      "deployments_2024.stateId",
      "deployments_2024.cost",
    ]);
  });

  it("adds only the measures' names for a summarize join", () => {
    const def = definitionWith(
      joinStep({ multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] } }),
    );
    expect(fieldsAfter(def, infos, 0)).toStrictEqual(["id", "name", "n"]);
  });

  it("replaces the shape after a group-by", () => {
    const def: ViewDefinition = {
      ...definitionWith(joinStep()),
      steps: [{ kind: "groupBy", by: ["name"], measures: [{ as: "n", fn: "count" }] }],
    };
    expect(fieldsAfter(def, infos, 0)).toStrictEqual(["name", "n"]);
  });
});

describe("join editing helpers", () => {
  it("defaults the prefix to the slugified title", () => {
    expect(joinStep().prefix).toBe("deployments_2024");
  });

  it("adds, replaces and removes manual key-map entries", () => {
    const first = withManualMapEntry(joinStep(), "Alabama ", "Alabama");
    expect(first.matching.manualMap).toStrictEqual([{ from: "Alabama ", to: "Alabama" }]);
    const replaced = withManualMapEntry(first, "Alabama ", "AL");
    expect(replaced.matching.manualMap).toStrictEqual([{ from: "Alabama ", to: "AL" }]);
    const cleared = withoutManualMapEntry(replaced, "Alabama ");
    expect(cleared.matching.manualMap).toBeUndefined();
  });

  it("flags incomplete steps with a reason", () => {
    expect(stepProblem(newJoinStep({ rightAlias: "", rightTitle: "" }))).toMatch(/dataset to join/);
    expect(stepProblem(joinStep({ on: [{ left: "id", right: "" }] }))).toMatch(/key fields/);
    expect(stepProblem(joinStep())).toBeUndefined();
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
  it("builds a blank definition over a base dataset", () => {
    const def = blankDefinition({ datasetId: STATES, title: "States" });
    expect(def.inputs).toStrictEqual([{ alias: "states", ref: { kind: "dataset", id: STATES } }]);
    expect(def.base).toBe("states");
  });

  it("keeps aliases unique and readable", () => {
    expect(uniqueAlias("States", ["states"])).toBe("states_2");
    expect(uniqueAlias("", [])).toBe("input");
  });

  it("drops inputs no step reads on save, never the base", () => {
    const def = definitionWith(joinStep());
    const unused: ViewDefinition = { ...def, steps: [] };
    expect(prunedInputs(unused).inputs.map((input) => input.alias)).toStrictEqual(["states"]);
    expect(inputRefsOf(def)).toStrictEqual([
      { alias: "states", datasetId: STATES },
      { alias: "deployments", datasetId: DEPLOYMENTS },
    ]);
  });

  it("summarizes validation problems with a count of the rest", () => {
    expect(validationSummary([{ message: "A" }, { message: "B" }, { message: "C" }])).toBe(
      "A (and 2 more)",
    );
    expect(validationSummary([{ message: "A" }])).toBe("A");
  });
});

describe("stepDiagnosticsOf", () => {
  const payload = {
    steps: [
      {
        index: 0,
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
    const step = stepDiagnosticsOf(payload, 0);
    expect(step).toMatchObject({ rowsIn: 50, rowsOut: 50 });
    expect(
      step === undefined || step.join === undefined ? [] : step.join.leftUnmatchedSamples,
    ).toStrictEqual(["Alabama "]);
  });

  it("reads a missing or malformed payload as no diagnostics", () => {
    expect(stepDiagnosticsOf(payload, 3)).toBeUndefined();
    expect(stepDiagnosticsOf({ nope: true }, 0)).toBeUndefined();
    expect(stepDiagnosticsOf(null, 0)).toBeUndefined();
  });
});

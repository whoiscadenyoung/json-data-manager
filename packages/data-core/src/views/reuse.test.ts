import { describe, expect, test } from "vitest";

import {
  applyExtract,
  canExtract,
  copyTitle,
  duplicateDefinition,
  joinAt,
  planExtract,
  remapInputs,
  remapReport,
  stepLabelOfPath,
} from "./reuse.js";
import { must } from "./test-fixtures-pglite.js";
import { workedExample, workedMetas } from "./test-fixtures-worked.js";
import type { CompileInputMeta, ViewDefinition } from "./types.js";

const NEW_STATES = "99999999-9999-4999-8999-999999999999";
const NEW_ID = "88888888-8888-4888-8888-888888888888";

describe("duplicate", () => {
  test("copies the definition and output labels without sharing references", () => {
    const copy = duplicateDefinition(workedExample);
    expect(copy).toEqual(workedExample);
    expect(copy).not.toBe(workedExample);
    expect(copy.output.fields[1]).toEqual({ key: "deployments", label: "Deployments" });
    must(copy.output.fields[1]).label = "Changed";
    expect(must(workedExample.output.fields[1]).label).toBe("Deployments");
  });

  test("the copy title", () => {
    expect(copyTitle("States enriched")).toBe("States enriched (copy)");
  });
});

describe("remap", () => {
  const statesLike = (fields: string[]): CompileInputMeta => ({
    alias: "states",
    datasetId: NEW_STATES,
    title: "Provinces",
    fields: fields.map((name) => ({ name })),
  });
  const swapped = (): ViewDefinition =>
    remapInputs(workedExample, [{ alias: "states", datasetId: NEW_STATES, oldTitle: "States" }]);
  const metasWith = (states: CompileInputMeta): CompileInputMeta[] => [
    states,
    ...workedMetas.filter((meta) => meta.alias !== "states"),
  ];

  test("re-points the input and leaves everything else", () => {
    const next = swapped();
    expect(next.inputs[0]).toEqual({ alias: "states", ref: { kind: "dataset", id: NEW_STATES } });
    expect(next.inputs.slice(1)).toEqual(workedExample.inputs.slice(1));
    expect(next.steps).toEqual(workedExample.steps);
  });

  test("a join whose right side moves keeps its output names", () => {
    const next = remapInputs(workedExample, [
      { alias: "links", datasetId: NEW_STATES, oldTitle: "Links" },
    ]);
    // spread columns do not use the prefix, so nothing is pinned.
    expect(must(next.steps[1])).toEqual(must(workedExample.steps[1]));
    const copying = {
      ...workedExample,
      steps: [
        {
          ...must(workedExample.steps[1]),
          multiMatch: { mode: "first" as const },
        },
      ],
    };
    const pinned = remapInputs(copying, [
      { alias: "links", datasetId: NEW_STATES, oldTitle: "Links" },
    ]);
    const join = must(pinned.steps[0]);
    expect(join.kind === "join" && join.prefix).toBe("links");
  });

  test("a compatible dataset validates", () => {
    const report = remapReport(swapped(), metasWith(statesLike(["id", "name"])));
    expect(report.ok).toBe(true);
  });

  test("missing fields are reported per step", () => {
    const report = remapReport(swapped(), metasWith(statesLike(["code", "title"])));
    expect(report.ok).toBe(false);
    if (report.ok) {
      return;
    }
    const steps = report.byStep.map((entry) => entry.step);
    expect(steps).toContain("Step 1");
    expect(steps).toContain("Step 2");
    const first = must(report.byStep.find((entry) => entry.step === "Step 1"));
    expect(first.messages.join(" ")).toMatch(/id/);
  });

  test("path labels", () => {
    expect(stepLabelOfPath("steps[1].on[0].left")).toBe("Step 2");
    expect(stepLabelOfPath("steps[0].right.steps[2].expr")).toBe("Step 1, sub-step 3");
    expect(stepLabelOfPath("output.fields[0]")).toBe("Output");
  });
});

describe("extract", () => {
  test("only a join with a non-empty sub-pipeline can be extracted", () => {
    expect(canExtract(workedExample, [0])).toBe(true);
    expect(canExtract(workedExample, [1])).toBe(false);
    expect(canExtract(workedExample, [5])).toBe(false);
    expect(must(joinAt(workedExample, [0, 0])).right.input).toBe("deploymentAgencies");
  });

  test("the new view starts at the right input, with the sub-pipeline and every field", () => {
    const planned = planExtract(workedExample, [0], "Deployments");
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    const { view } = planned.plan;
    expect(view.base).toBe("deployments");
    expect(view.inputs.map((input) => input.alias)).toEqual(["deployments", "deploymentAgencies"]);
    expect(view.steps).toEqual(must(joinAt(workedExample, [0])).right.steps);
    expect(view.output).toEqual({ fields: [], emptyFields: "keep" });
    // A summarize join does not use the prefix.
    expect(planned.plan.keepPrefix).toBeUndefined();
  });

  test("the join is rewritten to read the new view and unused inputs are pruned", () => {
    const planned = planExtract(workedExample, [0], "Deployments");
    if (!planned.ok) {
      throw new Error(planned.reason);
    }
    const edited = applyExtract(workedExample, [0], planned.plan, { id: NEW_ID, title: "Deps" });
    const join = must(edited.steps[0]);
    expect(join.kind === "join" && join.right).toEqual({ input: "deps" });
    expect(edited.inputs.map((input) => input.alias)).toEqual(["states", "links", "deps"]);
    expect(must(edited.inputs.find((input) => input.alias === "deps")).ref.id).toBe(NEW_ID);
    expect(edited.steps[1]).toEqual(workedExample.steps[1]);
    // The original is untouched.
    expect(canExtract(workedExample, [0])).toBe(true);
  });

  test("nested: extracting the inner sub-pipeline leaves the outer one", () => {
    const nested: ViewDefinition = {
      ...workedExample,
      steps: [
        {
          kind: "join",
          right: {
            input: "deployments",
            steps: [
              {
                kind: "join",
                right: {
                  input: "deploymentAgencies",
                  steps: [{ kind: "filter", where: { field: "agencyId", op: "neq", value: "a3" } }],
                },
                on: [{ left: "id", right: "deploymentId" }],
                matching: {
                  trim: false,
                  caseFold: false,
                  collapseSpace: false,
                  stripDiacritics: false,
                },
                type: "left",
                multiMatch: { mode: "summarize", measures: [{ as: "agencyCount", fn: "count" }] },
              },
            ],
          },
          on: [{ left: "id", right: "stateId" }],
          matching: { trim: false, caseFold: false, collapseSpace: false, stripDiacritics: false },
          type: "left",
          multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
        },
      ],
      output: { fields: [], emptyFields: "keep" },
    };
    const planned = planExtract(nested, [0, 0], "Deployment agencies");
    if (!planned.ok) {
      throw new Error(planned.reason);
    }
    expect(planned.plan.view.base).toBe("deploymentAgencies");
    expect(planned.plan.view.steps.map((step) => step.kind)).toEqual(["filter"]);
    const edited = applyExtract(nested, [0, 0], planned.plan, { id: NEW_ID, title: "Agencies" });
    const outer = must(edited.steps[0]);
    const outerSteps = outer.kind === "join" ? must(outer.right.steps) : [];
    expect(outerSteps).toHaveLength(1);
    const inner = must(outerSteps[0]);
    expect(inner.kind === "join" && inner.right).toEqual({ input: "agencies" });
    expect(edited.inputs.map((input) => input.alias)).toContain("agencies");
    expect(edited.inputs.map((input) => input.alias)).not.toContain("deploymentAgencies");
  });
});

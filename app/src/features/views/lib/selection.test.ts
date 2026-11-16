import type { ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { OUTPUT, settleSelection } from "./selection";
import { blankDefinition, newFilterStep, newJoinStep } from "./view-model";

function definition(subSteps: number): ViewDefinition {
  const base = blankDefinition({ datasetId: "d-states", title: "States" }),
    join = newJoinStep({ left: "id", right: "stateId", rightAlias: "links", rightTitle: "Links" });
  return {
    ...base,
    inputs: [...base.inputs, { alias: "links", ref: { kind: "dataset", id: "d-links" } }],
    steps: [
      {
        ...join,
        right: {
          ...join.right,
          steps: Array.from({ length: subSteps }, () => newFilterStep("id")),
        },
      },
    ],
  };
}

describe("settleSelection", () => {
  it("keeps a selection that still names something", () => {
    const two = definition(2);
    expect(settleSelection(0, two)).toBe(0);
    expect(settleSelection({ join: 0, step: 1 }, two)).toStrictEqual({ join: 0, step: 1 });
    expect(settleSelection({ input: "links" }, two)).toStrictEqual({ input: "links" });
    expect(settleSelection(OUTPUT, two)).toBe(OUTPUT);
  });

  it("falls back to the join when the selected sub-step is gone", () => {
    expect(settleSelection({ join: 0, step: 1 }, definition(1))).toBe(0);
    expect(settleSelection({ join: 0, step: 0 }, definition(0))).toBe(0);
  });

  it("falls back to the result when the step, join or input is gone", () => {
    const one = definition(1);
    expect(settleSelection(3, one)).toBe(OUTPUT);
    expect(settleSelection({ join: 2, step: 0 }, one)).toBe(OUTPUT);
    expect(settleSelection({ input: "gone" }, one)).toBe(OUTPUT);
  });
});

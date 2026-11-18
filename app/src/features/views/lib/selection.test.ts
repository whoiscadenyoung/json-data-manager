import type { ViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { nodeOf, OUTPUT, settleSelection } from "./selection";
import { appendNode, blankDefinitionOf } from "./view-model";

function definition(): ViewDefinition {
  const base = blankDefinitionOf([{ datasetId: "d-states", title: "States" }]);
  return appendNode(base, "states", "filter", "id").definition;
}

describe("settleSelection", () => {
  it("keeps a selection that still names a node", () => {
    const def = definition();
    expect(settleSelection({ node: "states" }, def)).toStrictEqual({ node: "states" });
    expect(settleSelection({ node: "filter_rows" }, def)).toStrictEqual({ node: "filter_rows" });
    expect(settleSelection(OUTPUT, def)).toBe(OUTPUT);
  });

  it("falls back to the output when the node is gone", () => {
    expect(settleSelection({ node: "gone" }, definition())).toBe(OUTPUT);
  });

  it("nodeOf reads the id", () => {
    expect(nodeOf({ node: "a" })).toBe("a");
    expect(nodeOf(OUTPUT)).toBeUndefined();
  });
});

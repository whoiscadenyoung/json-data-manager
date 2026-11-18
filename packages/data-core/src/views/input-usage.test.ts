import { describe, expect, test } from "vitest";

import { inputUsages, renameInputAlias } from "./reuse.js";
import { must } from "./test-fixtures-pglite.js";
import { definition, join } from "./test-fixtures.js";
import type { Step } from "./types.js";

const steps: Step[] = [
  join({ right: { input: "deployments" } }),
  { kind: "append", sources: [{ input: "links" }], tagField: "src" },
  { kind: "sql", query: "select * from in_deployments" },
];

describe("inputUsages", () => {
  test("lists the start and every reading step; unused inputs are empty", () => {
    const usages = inputUsages(definition(steps.slice(0, 2)));
    expect(must(usages.get("states")).map((u) => u.label)).toEqual(["Start"]);
    expect(must(usages.get("deployments")).map((u) => u.label)).toEqual(["Step 1 (Join)"]);
    expect(must(usages.get("links")).map((u) => u.label)).toEqual(["Step 2 (Stack)"]);
    expect(inputUsages(definition([])).get("links")).toEqual([]);
  });
  test("counts SQL in_<alias> reads", () => {
    const usages = inputUsages(definition(steps));
    expect(must(usages.get("deployments")).map((u) => u.label)).toContain("Step 3 (SQL)");
  });
});

describe("renameInputAlias", () => {
  test("rewrites base, inputs, join, stack and sql references", () => {
    const renamed = renameInputAlias(definition(steps), "deployments", "deps");
    expect(renamed.inputs.map((i) => i.alias)).toContain("deps");
    expect(must(inputUsages(renamed).get("deps")).length).toBe(2);
    const renamedBase = renameInputAlias(definition(steps), "states", "st");
    expect(renamedBase.base).toBe("st");
    const stack = renameInputAlias(definition(steps), "links", "ln").steps[1];
    expect(stack).toMatchObject({ sources: [{ input: "ln" }] });
  });
});

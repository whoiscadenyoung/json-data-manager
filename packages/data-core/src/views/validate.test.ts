import { describe, expect, test } from "vitest";

import { definition, join, metas, noNormalization } from "./test-fixtures.js";
import type { Step, ViewDefinition } from "./types.js";
import { validateViewDefinition } from "./validate.js";

function errorsOf(def: unknown, withMetas = false): { path: string; message: string }[] {
  const result = validateViewDefinition(def, withMetas ? metas : undefined);
  if (result.ok) {
    return [];
  }
  return result.errors;
}

function paths(def: unknown, withMetas = false): string[] {
  return errorsOf(def, withMetas).map((error) => error.path);
}

describe("validateViewDefinition", () => {
  test("accepts a well-formed definition", () => {
    const steps: Step[] = [
      { kind: "filter", where: { field: "name", op: "notNull" } },
      join({ multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] } }),
    ];
    const result = validateViewDefinition(definition(steps), metas);
    expect(result).toEqual({ ok: true, value: definition(steps) });
  });

  test("rejects non-objects", () => {
    expect(validateViewDefinition(null).ok).toBe(false);
    expect(validateViewDefinition("x").ok).toBe(false);
  });

  test("unknown input alias on a join", () => {
    const def = definition([join({ right: { input: "nope" } })]);
    expect(paths(def)).toContain("steps[0].right.input");
  });

  test("base not in inputs", () => {
    expect(paths(definition([], { base: "ghost" }))).toContain("base");
  });

  test("duplicate and uuid-looking aliases", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const def = definition([], {
      inputs: [
        { alias: "a", ref: { kind: "dataset", id: uuid } },
        { alias: "a", ref: { kind: "dataset", id: uuid } },
      ],
      base: "a",
    });
    expect(errorsOf(def).some((e) => e.message.includes("Duplicate"))).toBe(true);
    const bad = definition([], {
      inputs: [{ alias: "no spaces!", ref: { kind: "dataset", id: uuid } }],
      base: "no spaces!",
    });
    expect(paths(bad)).toContain("inputs[0].alias");
  });

  test("empty on", () => {
    expect(paths(definition([join({ on: [] })]))).toContain("steps[0].on");
  });

  test("spread without columns", () => {
    const step = join({
      multiMatch: { mode: "spread", by: "type", value: "url", columns: [] },
    });
    expect(paths(definition([step]))).toContain("steps[0].multiMatch.columns");
  });

  test("missing matching flags and bad join type", () => {
    const step = { ...join(), matching: {}, type: "outer" };
    const found = paths(definition([step as unknown as Step]));
    expect(found).toContain("steps[0].matching.trim");
    expect(found).toContain("steps[0].type");
  });

  test("measures need fields; duplicates are reported", () => {
    const step: Step = {
      kind: "groupBy",
      by: ["name"],
      measures: [
        { as: "a", fn: "sum" },
        { as: "a", fn: "count" },
      ],
    };
    const found = paths(definition([step]));
    expect(found).toContain("steps[0].measures[0].field");
    expect(found).toContain("steps[0].measures[1].as");
  });

  test("select and groupBy need fields", () => {
    expect(paths(definition([{ kind: "select", fields: [] }]))).toContain("steps[0].fields");
    expect(paths(definition([{ kind: "groupBy", by: [], measures: [] }]))).toContain("steps[0].by");
  });

  test("bad conditions", () => {
    const where = { and: [] };
    expect(paths(definition([{ kind: "filter", where }]))).toContain("steps[0].where.and");
    const op = { field: "a", op: "like", value: 1 };
    expect(paths(definition([{ kind: "filter", where: op } as unknown as Step]))).toContain(
      "steps[0].where.op",
    );
  });

  test("unknown step kind", () => {
    const step = { kind: "teleport" } as unknown as Step;
    expect(paths(definition([step]))).toContain("steps[0].kind");
  });

  test("a prefix that is a uuid is refused", () => {
    const step = join({ prefix: "11111111-1111-4111-8111-111111111111" });
    expect(paths(definition([step]))).toContain("steps[0].prefix");
  });
});

describe("field references (with input metadata)", () => {
  test("unknown filter field", () => {
    const step: Step = { kind: "filter", where: { field: "nope", op: "notNull" } };
    expect(paths(definition([step]), true)).toContain("steps[0].where.field");
    expect(paths(definition([step]), false)).toEqual([]);
  });

  test("unknown left and right join keys", () => {
    const step = join({ on: [{ left: "ghost", right: "phantom" }] });
    const found = paths(definition([step]), true);
    expect(found).toContain("steps[0].on[0].left");
    expect(found).toContain("steps[0].on[0].right");
  });

  test("joined fields are known to later steps, prefixed", () => {
    const steps: Step[] = [
      join(),
      { kind: "filter", where: { field: "deployments_2024.cost", op: "gt", value: 1 } },
      { kind: "filter", where: { field: "cost", op: "gt", value: 1 } },
    ];
    expect(paths(definition(steps), true)).toEqual(["steps[2].where.field"]);
  });

  test("summarize measure names flow forward; groupBy narrows the scope", () => {
    const steps: Step[] = [
      join({
        multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
        matching: noNormalization,
      }),
      { kind: "groupBy", by: ["n"], measures: [{ as: "c", fn: "count" }] },
      { kind: "filter", where: { field: "name", op: "notNull" } },
    ];
    expect(paths(definition(steps), true)).toEqual(["steps[2].where.field"]);
  });

  test("unknown output key", () => {
    const def: ViewDefinition = definition([], {
      output: { fields: [{ key: "missing" }], emptyFields: "keep" },
    });
    expect(paths(def, true)).toContain("output.fields[0].key");
  });

  test("a sql step makes the row shape unknown, so later refs are not checked", () => {
    const steps: Step[] = [
      { kind: "sql", query: "select 1" },
      { kind: "filter", where: { field: "anything", op: "notNull" } },
    ];
    expect(paths(definition(steps), true)).toEqual([]);
  });
});

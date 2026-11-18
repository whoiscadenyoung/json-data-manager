import { describe, expect, test } from "vitest";

import { chain as definition, join, metas, noNormalization } from "./test-fixtures.js";
import type { ChainStep } from "./test-fixtures.js";
import type { ViewDefinition } from "./types.js";

type Step = ChainStep;
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

  test("unknown node on a join, a missing result and bad ids", () => {
    const def = definition([join({ right: "nope" })]);
    expect(paths(def)).toContain("nodes.s0.right");
    const base = definition([]);
    expect(paths({ ...base, result: { ...base.result, node: "ghost" } })).toContain("result.node");
    const uuid = "11111111-1111-4111-8111-111111111111";
    const bad = { ...base, nodes: { ...base.nodes, [`n_${uuid}`]: base.nodes.states } };
    expect(paths(bad)).toContain(`nodes.n_${uuid}`);
    expect(paths({ ...base, nodes: { ...base.nodes, "No Spaces!": base.nodes.states } })).toContain(
      "nodes.No Spaces!",
    );
  });

  test("empty on", () => {
    expect(paths(definition([join({ on: [] })]))).toContain("nodes.s0.on");
  });

  test("spread without columns", () => {
    const step = join({
      multiMatch: { mode: "spread", by: "type", value: "url", columns: [] },
    });
    expect(paths(definition([step]))).toContain("nodes.s0.multiMatch.columns");
  });

  test("missing matching flags and bad join type", () => {
    const step = { ...join(), matching: {}, type: "outer" };
    const found = paths(definition([step as unknown as Step]));
    expect(found).toContain("nodes.s0.matching.trim");
    expect(found).toContain("nodes.s0.type");
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
    expect(found).toContain("nodes.s0.measures[0].field");
    expect(found).toContain("nodes.s0.measures[1].as");
  });

  test("columns, calculate and groupBy need their lists", () => {
    expect(paths(definition([{ kind: "columns" } as unknown as Step]))).toContain("nodes.s0.edits");
    expect(paths(definition([{ kind: "calculate", fields: [] }]))).toContain("nodes.s0.fields");
    expect(paths(definition([{ kind: "groupBy", by: [], measures: [] }]))).toContain("nodes.s0.by");
  });

  test("bad conditions", () => {
    const where = { and: [] };
    expect(paths(definition([{ kind: "filter", where }]))).toContain("nodes.s0.where.and");
    const op = { field: "a", op: "like", value: 1 };
    expect(paths(definition([{ kind: "filter", where: op } as unknown as Step]))).toContain(
      "nodes.s0.where.op",
    );
  });

  test("unknown step kind", () => {
    const step = { kind: "teleport" } as unknown as Step;
    expect(paths(definition([step]))).toContain("nodes.s0.kind");
  });

  test("a prefix that is a uuid is refused", () => {
    const step = join({ prefix: "11111111-1111-4111-8111-111111111111" });
    expect(paths(definition([step]))).toContain("nodes.s0.prefix");
  });
});

describe("field references (with input metadata)", () => {
  test("unknown filter field", () => {
    const step: Step = { kind: "filter", where: { field: "nope", op: "notNull" } };
    expect(paths(definition([step]), true)).toContain("nodes.s0.where.field");
    expect(paths(definition([step]), false)).toEqual([]);
  });

  test("unknown left and right join keys", () => {
    const step = join({ on: [{ left: "ghost", right: "phantom" }] });
    const found = paths(definition([step]), true);
    expect(found).toContain("nodes.s0.on[0].left");
    expect(found).toContain("nodes.s0.on[0].right");
  });

  test("joined fields are known to later steps, prefixed", () => {
    const steps: Step[] = [
      join(),
      { kind: "filter", where: { field: "deployments_2024.cost", op: "gt", value: 1 } },
      { kind: "filter", where: { field: "cost", op: "gt", value: 1 } },
    ];
    expect(paths(definition(steps), true)).toEqual(["nodes.s2.where.field"]);
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
    expect(paths(definition(steps), true)).toEqual(["nodes.s2.where.field"]);
  });

  test("unknown output key", () => {
    const def: ViewDefinition = definition([], {
      fields: [{ key: "missing" }],
      emptyFields: "keep",
    });
    expect(paths(def, true)).toContain("result.output.fields[0].key");
  });

  test("an output rename checks its source field, not the new key", () => {
    const ok: ViewDefinition = definition([], {
      fields: [{ key: "town", from: "name" }],
      emptyFields: "keep",
    });
    expect(paths(ok, true)).toEqual([]);
    const bad: ViewDefinition = definition([], {
      fields: [{ key: "town", from: "missing" }],
      emptyFields: "keep",
    });
    expect(paths(bad, true)).toContain("result.output.fields[0].from");
  });

  test("a sql step returning d makes the row shape unknown, so later refs are not checked", () => {
    const steps: Step[] = [
      { kind: "sql", query: "select * from prev" },
      { kind: "filter", where: { field: "anything", op: "notNull" } },
    ];
    expect(paths(definition(steps), true)).toEqual([]);
  });
});

function located(steps: Step[], withMetas = true) {
  const result = validateViewDefinition(definition(steps), withMetas ? metas : undefined);
  return result.ok ? [] : result.errors;
}

describe("calculate and sql nodes", () => {
  test("calculate: a syntax error carries its position", () => {
    const [error] = located(
      [{ kind: "calculate", fields: [{ field: "x", expr: "1 + (2" }] }],
      false,
    );
    expect(error).toMatchObject({
      path: "nodes.s0.fields[0].expr",
      position: { start: 4, end: 5 },
    });
    expect(error.message).toContain("never closed");
  });

  test("calculate: unknown function and unknown field are located", () => {
    const [fn] = located([
      { kind: "calculate", fields: [{ field: "x", expr: "name + sleep(1)" }] },
    ]);
    expect(fn).toMatchObject({ path: "nodes.s0.fields[0].expr", position: { start: 7, end: 15 } });
    const [field] = located([{ kind: "calculate", fields: [{ field: "x", expr: "lower(nope)" }] }]);
    expect(field).toMatchObject({
      message: 'Unknown field "nope".',
      position: { start: 6, end: 10 },
    });
  });

  test("calculate: needs text, and its field joins the scope for later steps", () => {
    const bad = {
      kind: "calculate",
      fields: [{ field: "x", expr: { op: "+" } }],
    } as unknown as Step;
    expect(paths(definition([bad]))).toContain("nodes.s0.fields[0].expr");
    const steps: Step[] = [
      { kind: "calculate", fields: [{ field: "double", expr: "stateName" }] },
      { kind: "filter", where: { field: "double", op: "notNull" } },
      { kind: "filter", where: { field: "other", op: "notNull" } },
    ];
    expect(located(steps).map((e) => e.path)).toEqual(["nodes.s2.where.field"]);
  });

  test("calculate: later fields read earlier ones in the same node", () => {
    const ok: Step = {
      kind: "calculate",
      fields: [
        { field: "a", expr: "1 + 1" },
        { field: "b", expr: "a * 2" },
      ],
    };
    expect(located([ok])).toEqual([]);
  });

  test("calculate: types flow, so a type error is caught", () => {
    const steps: Step[] = [
      join({ right: "deployments", prefix: "d" }),
      { kind: "calculate", fields: [{ field: "x", expr: '"d.stateId" = "d.cost"' }] },
    ];
    expect(located(steps)[0].message).toContain("different types");
  });

  test("sql: DML, undeclared tables and multiple statements are rejected", () => {
    const query = (text: string): string[] =>
      located([{ kind: "sql", query: text }]).map((e) => e.message);
    expect(query("delete from prev")[0]).toContain("Only SELECT");
    expect(query("with x as (delete from prev returning *) select * from x")[0]).toContain(
      "Only SELECT",
    );
    expect(query("select * from secrets")[0]).toContain("Unknown table");
    expect(query("select * from prev; select * from prev")[0]).toContain("Only one statement");
    expect(query("select * from prev")).toEqual([]);
    const [positioned] = located([{ kind: "sql", query: "select * from prev, secrets" }]);
    expect(positioned).toMatchObject({ path: "nodes.s0.query" });
    expect(positioned.position).toEqual({ start: 20, end: 27 });
  });

  test("sql: output columns become the known fields", () => {
    const steps: Step[] = [
      { kind: "sql", query: "select d ->> 'a' as a, row_id from prev" },
      { kind: "filter", where: { field: "a", op: "notNull" } },
      { kind: "filter", where: { field: "row_id", op: "notNull" } },
    ];
    expect(located(steps).map((e) => e.path)).toEqual(["nodes.s2.where.field"]);
  });

  test("text and list multi-matches add their fields; their inputs are checked", () => {
    const text = join({ multiMatch: { mode: "text", field: "name", separator: ", " } });
    const steps: Step[] = [
      text,
      { kind: "filter", where: { field: "deployments_2024.name", op: "notNull" } },
    ];
    expect(located(steps)).toEqual([]);
    const badText = join({ multiMatch: { mode: "text", field: "nope", separator: "," } });
    expect(located([badText]).map((e) => e.path)).toEqual(["nodes.s0.multiMatch.field"]);
    const list: Step[] = [
      join({ multiMatch: { mode: "list" } }),
      { kind: "filter", where: { field: "deployments_2024", op: "notNull" } },
    ];
    expect(located(list)).toEqual([]);
    const shape = join({ multiMatch: { mode: "text", field: "name" } as never });
    expect(paths(definition([shape]))).toContain("nodes.s0.multiMatch");
  });
});

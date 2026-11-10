import { describe, expect, test } from "vitest";

import { compileDiagnostics, compileView, viewInputDatasetIds } from "./compile.js";
import { ViewStepNotSupportedError } from "./errors.js";
import {
  DEPLOYMENTS_ID,
  LINKS_ID,
  STATES_ID,
  definition,
  fullNormalization,
  join,
  metas,
  noNormalization,
} from "./test-fixtures.js";
import type { Condition, ConditionLeaf, Step } from "./types.js";

/** Golden SQL: the statement text and its params, as a single snapshot. */
function golden(query: { sql: string; params: unknown[] }): string {
  return `${query.sql}\n-- params: ${JSON.stringify(query.params)}`;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("input CTEs", () => {
  test("no steps: base input over entries + geometries", () => {
    expect(golden(compileView(definition([]), metas))).toMatchSnapshot();
  });

  test("pinned version reads version_entries by ref", () => {
    const def = definition([join({ right: { input: "links" } })]);
    const { sql, params } = compileView(def, metas);
    expect(sql).toContain("public.version_entries");
    expect(params).toContain("v-ref-1");
    expect(params).toContain(LINKS_ID);
    expect(params).toContain(STATES_ID);
  });

  test("uptoStep limits the compiled steps and limit appends LIMIT", () => {
    const steps: Step[] = [{ kind: "filter", where: { field: "name", op: "notNull" } }, join()];
    const upto = compileView(definition(steps), metas, { uptoStep: 0, limit: 50 });
    expect(upto.sql).not.toContain("deployments");
    expect(upto.sql.trimEnd().endsWith("limit 50")).toBe(true);
    expect(golden(upto)).toMatchSnapshot();
  });
});

describe("filter", () => {
  const leaves: ConditionLeaf[] = [
    { field: "name", op: "eq", value: "Kansas" },
    { field: "name", op: "neq", value: "Kansas" },
    { field: "pop", op: "gt", value: 10 },
    { field: "pop", op: "gte", value: 10 },
    { field: "name", op: "lt", value: "M" },
    { field: "pop", op: "lte", value: 10 },
    { field: "name", op: "in", value: ["Kansas", "Iowa"] },
    { field: "name", op: "contains", value: "an" },
    { field: "name", op: "isNull" },
    { field: "name", op: "notNull" },
  ];

  test.each(leaves.map((leaf) => [leaf.op, leaf] as const))("leaf %s", (_op, where) => {
    expect(golden(compileView(definition([{ kind: "filter", where }]), metas))).toMatchSnapshot();
  });

  test("and / or / not branches", () => {
    const where: Condition = {
      and: [
        { not: { field: "name", op: "isNull" } },
        {
          or: [
            { field: "pop", op: "gt", value: 1 },
            { field: "name", op: "eq", value: "x" },
          ],
        },
      ],
    };
    expect(golden(compileView(definition([{ kind: "filter", where }]), metas))).toMatchSnapshot();
  });

  test("values and keys are bound, never spliced", () => {
    const evil = "x'; drop table entries; --";
    const where: Condition = { field: evil, op: "eq", value: evil };
    const { sql, params } = compileView(definition([{ kind: "filter", where }]), metas);
    expect(sql).not.toContain("drop table");
    expect(params).toContain(evil);
    expect(params).toContain(JSON.stringify(evil));
  });

  test("identifiers from aliases are quoted", () => {
    const def = definition([], {
      inputs: [{ alias: 'we"ird', ref: { kind: "dataset", id: STATES_ID } }],
      base: 'we"ird',
    });
    const { sql } = compileView(def, [{ alias: 'we"ird', datasetId: STATES_ID, title: "T" }]);
    expect(sql).toContain('"in_we""ird"');
  });
});

describe("join: first / last", () => {
  test("first with orderBy and a field list", () => {
    const step = join({
      multiMatch: { mode: "first", orderBy: [{ field: "cost", direction: "desc" }] },
      fields: ["name", "cost"],
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("last reverses the order; all right fields get the title prefix", () => {
    const step = join({ multiMatch: { mode: "last", orderBy: [{ field: "cost" }] } });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("inner join, explicit prefix and a composite key", () => {
    const step = join({
      type: "inner",
      prefix: "dep",
      on: [
        { left: "id", right: "stateId" },
        { left: "name", right: "name" },
      ],
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });
});

describe("join: summarize", () => {
  test("every supported measure, with emptyValue and the count default", () => {
    const step = join({
      multiMatch: {
        mode: "summarize",
        measures: [
          { as: "n", fn: "count" },
          { as: "nCost", fn: "count", field: "cost" },
          { as: "agencies", fn: "countDistinct", field: "name" },
          { as: "total", fn: "sum", field: "cost", emptyValue: 0 },
          { as: "mean", fn: "avg", field: "cost", emptyValue: null },
          { as: "lo", fn: "min", field: "cost", emptyValue: "none" },
          { as: "hi", fn: "max", field: "name" },
        ],
      },
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("inner summarize join", () => {
    const step = join({
      type: "inner",
      multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });
});

describe("key matching", () => {
  test("every normalization option, translate() fallback", () => {
    const step = join({
      right: { input: "links" },
      on: [{ left: "stateName", right: "stateName" }],
      matching: fullNormalization,
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("unaccent option swaps in unaccent()", () => {
    const step = join({
      right: { input: "links" },
      on: [{ left: "stateName", right: "stateName" }],
      matching: { ...noNormalization, stripDiacritics: true },
    });
    const query = compileView(definition([step]), metas, { unaccent: true });
    expect(query.sql).toContain("unaccent(");
    expect(query.sql).not.toContain("translate(");
    expect(golden(query)).toMatchSnapshot();
  });

  test("manual map applies to the left key via a VALUES CTE", () => {
    const step = join({
      right: { input: "links" },
      on: [{ left: "stateName", right: "stateName" }],
      matching: {
        ...fullNormalization,
        manualMap: [{ from: "Kans.", to: "Kansas" }],
      },
    });
    const query = compileView(definition([step]), metas);
    expect(query.params).toContain("Kans.");
    expect(golden(query)).toMatchSnapshot();
  });
});

describe("groupBy and select", () => {
  test("groupBy drops geometry and aggregates", () => {
    const step: Step = {
      kind: "groupBy",
      by: ["name"],
      measures: [
        { as: "n", fn: "count" },
        { as: "total", fn: "sum", field: "pop" },
      ],
    };
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("select renames and the output schema restricts keys", () => {
    const step: Step = {
      kind: "select",
      fields: [
        { from: "name", as: "State" },
        { from: "pop", as: "Population" },
      ],
    };
    const later: Step = { kind: "filter", where: { field: "State", op: "notNull" } };
    const def = definition([step, later], {
      output: { fields: [{ key: "State", label: "State name" }], emptyFields: "omit" },
    });
    const full = compileView(def, metas);
    expect(full.sql).toContain("jsonb_array_elements_text");
    expect(golden(full)).toMatchSnapshot();
    const partial = compileView(def, metas, { uptoStep: 0 });
    expect(partial.sql).not.toContain("jsonb_array_elements_text");
  });
});

describe("diagnostics", () => {
  test("join + filter diagnostics query", () => {
    const steps: Step[] = [
      { kind: "filter", where: { field: "name", op: "notNull" } },
      join({
        multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
        matching: { ...noNormalization, trim: true, caseFold: true },
      }),
    ];
    const query = compileDiagnostics(definition(steps), metas);
    expect(query.sql).toContain("as diagnostics");
    expect(query.sql).toContain("leftUnmatchedSamples");
    expect(query.sql).toContain("limit 20");
    expect(golden(query)).toMatchSnapshot();
  });

  test("uptoStep applies to diagnostics", () => {
    const steps: Step[] = [{ kind: "filter", where: { field: "name", op: "notNull" } }, join()];
    const query = compileDiagnostics(definition(steps), metas, { uptoStep: 0 });
    expect(query.sql).not.toContain("leftMatched");
  });
});

describe("unsupported", () => {
  const cases: [string, Step][] = [
    ["calculate", { kind: "calculate", field: "x", expr: { op: "+" } }],
    ["sql", { kind: "sql", query: "select 1" }],
    [
      "spread",
      join({
        multiMatch: {
          mode: "spread",
          by: "type",
          value: "url",
          columns: [{ category: "docs", as: "docsLink" }],
        },
      }),
    ],
    ["text", join({ multiMatch: { mode: "text", field: "name", separator: "," } })],
    ["list", join({ multiMatch: { mode: "list" } })],
    ["error", join({ multiMatch: { mode: "error" } })],
    [
      "topBy",
      join({
        multiMatch: {
          mode: "summarize",
          measures: [{ as: "m", fn: "topBy", field: "name", by: "cost", direction: "max" }],
        },
      }),
    ],
    [
      "text measure",
      join({
        multiMatch: {
          mode: "summarize",
          measures: [{ as: "m", fn: "text", field: "name", separator: "," }],
        },
      }),
    ],
    [
      "sub-pipeline",
      join({
        right: {
          input: "deployments",
          steps: [{ kind: "filter", where: { field: "a", op: "notNull" } }],
        },
      }),
    ],
  ];

  test.each(cases)("%s throws ViewStepNotSupportedError", (_name, step) => {
    expect(() => compileView(definition([step]), metas)).toThrow(ViewStepNotSupportedError);
    expect(() => compileDiagnostics(definition([step]), metas)).toThrow(ViewStepNotSupportedError);
  });

  test("the error carries kind and mode", () => {
    const thrown = catchError(() =>
      compileView(definition([join({ multiMatch: { mode: "list" } })]), metas),
    );
    expect(thrown).toBeInstanceOf(ViewStepNotSupportedError);
    expect(thrown).toMatchObject({ kind: "join", mode: "list" });
  });
});

describe("readable names, never uuids", () => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  test("the default join prefix comes from the dataset title", () => {
    const { sql, params } = compileView(definition([join()]), metas);
    expect(params).toContain("deployments_2024.");
    expect(sql).not.toContain("deployments_2024.");
  });

  test("no generated field name or identifier contains a uuid", () => {
    const steps: Step[] = [
      join(),
      join({ right: { input: "links" }, on: [{ left: "name", right: "stateName" }] }),
    ];
    const { sql, params } = compileView(definition(steps), metas);
    const datasetIds = new Set([STATES_ID, DEPLOYMENTS_ID, LINKS_ID]);
    // Dataset ids appear only as bound uuid params, never as names or in SQL text.
    expect(uuid.test(sql)).toBe(false);
    const uuidParams = params.filter((param) => typeof param === "string" && uuid.test(param));
    expect(uuidParams.every((param) => datasetIds.has(String(param)))).toBe(true);
  });
});

describe("viewInputDatasetIds", () => {
  test("distinct dataset ids in input order", () => {
    expect(viewInputDatasetIds(definition([]), metas)).toEqual([
      STATES_ID,
      DEPLOYMENTS_ID,
      LINKS_ID,
    ]);
  });
});

import { describe, expect, test } from "vitest";

import { compileDiagnostics, compileView, viewInputDatasetIds } from "./compile.js";
import { ViewCompileError } from "./errors.js";
import {
  DEPLOYMENTS_ID,
  LINKS_ID,
  STATES_ID,
  chain as definition,
  fullNormalization,
  graph,
  join,
  metas,
  noNormalization,
} from "./test-fixtures.js";
import type { ChainStep } from "./test-fixtures.js";
import type { Condition, ConditionLeaf, JoinNode, ViewDefinition } from "./types.js";

type Step = ChainStep;
type JoinStep = JoinNode;

/** Golden SQL: the statement text and its params, as a single snapshot. */
function golden(query: { sql: string; params: unknown[] }): string {
  return `${query.sql}\n-- params: ${JSON.stringify(query.params)}`;
}

/** `states` with typed fields, for calculate: the compiler checks refs against known fields. */
const calcMetas = metas.map((meta) =>
  meta.node === "states"
    ? {
        ...meta,
        fields: [
          { name: "name", type: "string" as const },
          { name: "cost", type: "number" as const },
          { name: "state name", type: "string" as const },
          { name: "opened", type: "date" as const },
          { name: "stateId" },
        ],
      }
    : meta,
);

describe("input CTEs", () => {
  test("no steps: base input over entries + geometries", () => {
    expect(golden(compileView(definition([]), metas))).toMatchSnapshot();
  });

  test("pinned version reads version_entries by ref", () => {
    const def = definition([join({ right: "links" })]);
    const { sql, params } = compileView(def, metas);
    expect(sql).toContain("public.version_entries");
    expect(params).toContain("v-ref-1");
    expect(params).toContain(LINKS_ID);
    expect(params).toContain(STATES_ID);
  });

  test("uptoNode limits the compiled nodes and limit appends LIMIT", () => {
    const steps: Step[] = [{ kind: "filter", where: { field: "name", op: "notNull" } }, join()];
    const upto = compileView(definition(steps), metas, { uptoNode: "s0", limit: 50 });
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

  test("identifiers from node ids are quoted", () => {
    const def: ViewDefinition = {
      nodes: { 'we"ird': { kind: "source", ref: { kind: "dataset", id: STATES_ID } } },
      result: { node: 'we"ird', output: { fields: [], emptyFields: "keep" } },
    };
    const { sql } = compileView(def, [{ node: 'we"ird', datasetId: STATES_ID, title: "T" }]);
    expect(sql).toContain('"in_we""ird"');
  });
});

describe("stack", () => {
  test("rename and exclude per input edge, tags on the edge", () => {
    const def = graph(
      {
        stacked: {
          kind: "stack",
          tagField: "fiscal_year",
          inputs: [
            { node: "states", tag: 2022, columns: [{ from: "stateName", as: "amount" }] },
            {
              node: "deployments",
              tag: 2023,
              columns: [
                { from: "cost", as: "amount" },
                { from: "stateId", exclude: true },
              ],
            },
          ],
        },
      },
      "stacked",
    );
    expect(golden(compileView(def, metas))).toMatchSnapshot();
  });
});

describe("columns", () => {
  test("many edits plus an `only` list in one node", () => {
    const step: Step = {
      kind: "columns",
      edits: [
        { from: "name", as: "State" },
        { from: "pop", exclude: true },
      ],
      only: ["State", "id"],
    };
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
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
      right: "links",
      on: [{ left: "stateName", right: "stateName" }],
      matching: fullNormalization,
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("unaccent option swaps in unaccent()", () => {
    const step = join({
      right: "links",
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
      right: "links",
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

describe("groupBy and columns", () => {
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

  test("columns renames and the output schema restricts keys", () => {
    const step: Step = {
      kind: "columns",
      edits: [
        { from: "name", as: "State" },
        { from: "pop", as: "Population" },
      ],
      only: ["State", "Population"],
    };
    const later: Step = { kind: "filter", where: { field: "State", op: "notNull" } };
    const def = definition([step, later], {
      fields: [{ key: "State", label: "State name" }],
      emptyFields: "omit",
    });
    const full = compileView(def, metas);
    expect(full.sql).toContain("jsonb_each(d) e");
    expect(golden(full)).toMatchSnapshot();
    const partial = compileView(def, metas, { uptoNode: "s0" });
    expect(partial.sql).not.toContain("jsonb_each(d) e");
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

  test("uptoNode applies to diagnostics", () => {
    const steps: Step[] = [{ kind: "filter", where: { field: "name", op: "notNull" } }, join()];
    const query = compileDiagnostics(definition(steps), metas, { uptoNode: "s0" });
    expect(query.sql).not.toContain("leftMatched");
  });
});

/** A join of the links input on the state name, trimmed and case-folded. */
function linkJoin(multiMatch: JoinStep["multiMatch"], overrides: Partial<JoinStep> = {}): Step {
  return join({
    right: "links",
    on: [{ left: "name", right: "stateName" }],
    matching: { ...noNormalization, trim: true, caseFold: true },
    multiMatch,
    ...overrides,
  });
}

describe("join: spread / text / list / error", () => {
  test("spread: one declared column per category", () => {
    const step = linkJoin({
      mode: "spread",
      by: "type",
      value: "url",
      columns: [
        { category: "docs", as: "docsLink" },
        { category: "benefits", as: "benefitsLink" },
      ],
    });
    const query = compileView(definition([step]), metas);
    expect(query.params).toContain("docs");
    expect(golden(query)).toMatchSnapshot();
  });

  test("text: string_agg with a bound separator", () => {
    const step = linkJoin({ mode: "text", field: "url", separator: "; " });
    const query = compileView(definition([step]), metas);
    expect(query.params).toContain("; ");
    expect(golden(query)).toMatchSnapshot();
  });

  test("list: jsonb_agg of whole rows, or of the chosen fields", () => {
    expect(golden(compileView(definition([linkJoin({ mode: "list" })]), metas))).toMatchSnapshot(
      "whole rows",
    );
    const picked = linkJoin({ mode: "list" }, { fields: ["type", "url"], prefix: "links" });
    expect(golden(compileView(definition([picked]), metas))).toMatchSnapshot("chosen fields");
  });

  test("error: a cast guard raises on duplicate keys; diagnostics leave it out", () => {
    const step = linkJoin({ mode: "error" });
    const rows = compileView(definition([step]), metas);
    expect(rows.sql).toContain(")::int");
    expect(golden(rows)).toMatchSnapshot();
    const diagnostics = compileDiagnostics(definition([step]), metas);
    expect(diagnostics.sql).not.toContain(")::int");
    expect(diagnostics.sql).toContain("multiMatchKeys");
  });

  test("spread diagnostics report categories without a declared column", () => {
    const step = linkJoin({
      mode: "spread",
      by: "type",
      value: "url",
      columns: [{ category: "docs", as: "docsLink" }],
    });
    const query = compileDiagnostics(definition([step]), metas);
    expect(query.sql).toContain("undeclaredCategories");
    expect(golden(query)).toMatchSnapshot();
  });
});

describe("measures: topBy and text", () => {
  test("topBy (max, min) and text in a join summarize", () => {
    const step = join({
      multiMatch: {
        mode: "summarize",
        measures: [
          { as: "priciest", fn: "topBy", field: "name", by: "cost", direction: "max" },
          { as: "cheapest", fn: "topBy", field: "name", by: "cost", direction: "min" },
          { as: "names", fn: "text", field: "name", separator: " / " },
        ],
      },
    });
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("groupBy accepts the same measures", () => {
    const step: Step = {
      kind: "groupBy",
      by: ["stateId"],
      measures: [
        { as: "top", fn: "topBy", field: "name", by: "cost" },
        { as: "all", fn: "text", field: "name", separator: "," },
      ],
    };
    expect(golden(compileView(definition([step]), metas))).toMatchSnapshot();
  });

  test("topBy needs a by field at compile time", () => {
    const step: Step = {
      kind: "groupBy",
      by: ["stateId"],
      measures: [{ as: "top", fn: "topBy", field: "name" }],
    };
    expect(() => compileView(definition([step]), metas)).toThrow(ViewCompileError);
  });
});

describe("graph shape", () => {
  const nodes: Record<string, ViewDefinition["nodes"][string]> = {
    big: { kind: "filter", from: "deployments", where: { field: "cost", op: "gt", value: 0 } },
    joined: join({ right: "big" }) as never,
  };

  test("a join reads another node; CTEs are named from node ids", () => {
    const def = graph(
      { big: nodes.big, joined: { ...(nodes.joined as object), left: "states" } as never },
      "joined",
    );
    const query = compileView(def, metas);
    expect(query.sql).toContain('"in_big"');
    expect(query.sql).toContain('"l_joined"');
    expect(golden(query)).toMatchSnapshot();
  });

  test("CTE names are unique across nodes", () => {
    const def = graph(
      {
        a: { ...(join({ right: "deployments" }) as object), left: "states" } as never,
        b: { ...(join({ right: "deployments", prefix: "again" }) as object), left: "a" } as never,
      },
      "b",
    );
    const names = [...compileView(def, metas).sql.matchAll(/^("[^"]+")(?:\([^)]*\))? as \(/gm)];
    expect(new Set(names.map((match) => match[1])).size).toBe(names.length);
  });

  test("diagnostics list every compiled node by id", () => {
    const def = graph({ big: nodes.big }, "big");
    const query = compileDiagnostics(def, metas);
    expect(query.params).toContain("big");
    expect(query.params).toContain("deployments");
    expect(query.params).not.toContain("links");
  });
});

describe("calculate", () => {
  test("typed refs, literals bound as params", () => {
    const step: Step = {
      kind: "calculate",
      fields: [{ field: "total", expr: "round(cost * 1.5 + 2, 1)" }],
    };
    const query = compileView(definition([step]), calcMetas);
    expect(query.params).toContain(1.5);
    expect(query.params).toContain("total");
    expect(golden(query)).toMatchSnapshot();
  });

  test("every function, case and if", () => {
    const expr =
      "concat(upper(trim(name)), ' / ', lower(\"state name\")) = 'x' or coalesce(cost, 0) > 1 and not (cost is null) or year(opened) = 2024 + month(opened) - day(opened)";
    const step: Step = { kind: "calculate", fields: [{ field: "flag", expr }] };
    expect(golden(compileView(definition([step]), calcMetas))).toMatchSnapshot("functions");
    const cased: Step = {
      kind: "calculate",
      fields: [
        {
          field: "band",
          expr: "case when cost > 100 then 'high' when cost > 10 then 'mid' else if(cost is null, 'none', 'low') end",
        },
      ],
    };
    expect(golden(compileView(definition([cased]), calcMetas))).toMatchSnapshot("case");
  });

  test("hostile text is a bound param, never SQL", () => {
    const step: Step = {
      kind: "calculate",
      fields: [{ field: "x", expr: "'a''; drop table entries; --'" }],
    };
    const { sql, params } = compileView(definition([step]), calcMetas);
    expect(sql).not.toContain("drop table");
    expect(params).toContain("a'; drop table entries; --");
  });

  test("unknown functions and bad syntax throw ViewCompileError", () => {
    for (const expr of ["sleep(1)", "(1 + 2", "cost +"]) {
      const step: Step = { kind: "calculate", fields: [{ field: "x", expr }] };
      expect(() => compileView(definition([step]), calcMetas)).toThrow(ViewCompileError);
    }
  });
});

describe("sql step", () => {
  test("plain columns are folded into d; prev points at the node it reads", () => {
    const step: Step = {
      kind: "sql",
      query:
        "select p.d ->> 'name' as name, (p.d ->> 'cost')::numeric * 2 as double from prev p where p.d ->> 'name' is not null",
    };
    const query = compileView(
      definition([{ kind: "filter", where: { field: "name", op: "notNull" } }, step]),
      metas,
    );
    expect(query.sql).toContain('from "in_s0" p');
    expect(golden(query)).toMatchSnapshot();
  });

  test("d / row_id / geom columns pass through; input CTEs are emitted on demand", () => {
    const step: Step = {
      kind: "sql",
      reads: ["deployments"],
      query:
        "select p.row_id, p.d || jsonb_build_object('n', (select count(*) from in_deployments)) as d, p.geom from prev p;",
    };
    const query = compileView(definition([step]), metas);
    expect(query.sql).toContain('"in_deployments" as (');
    expect(golden(query)).toMatchSnapshot();
  });

  test("select * from prev keeps row_id, d and geom", () => {
    const step: Step = { kind: "sql", query: "select * from prev -- trailing comment" };
    const query = compileView(definition([step]), metas);
    expect(golden(query)).toMatchSnapshot();
  });

  test("an invalid query fails compilation with a located error", () => {
    const step: Step = { kind: "sql", query: "delete from prev" };
    expect(() => compileView(definition([step]), metas)).toThrow(ViewCompileError);
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
      join({ right: "links", on: [{ left: "name", right: "stateName" }] }),
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

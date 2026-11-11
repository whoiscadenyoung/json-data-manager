import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { compileDiagnostics, compileView } from "./compile.js";
import { addRows, createDb, must, runQuery, setGeom } from "./test-fixtures-pglite.js";
import { join, noNormalization } from "./test-fixtures.js";
import type { CompileInputMeta, JoinStep, Step, ViewDefinition } from "./types.js";

const STATES = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEMS = "aaaaaaaa-0000-4000-8000-000000000002";
const TAGS = "aaaaaaaa-0000-4000-8000-000000000003";

const metas: CompileInputMeta[] = [
  { alias: "states", datasetId: STATES, title: "States" },
  { alias: "items", datasetId: ITEMS, title: "Items" },
  { alias: "tags", datasetId: TAGS, title: "Tags" },
];

function view(steps: Step[]): ViewDefinition {
  return {
    inputs: metas.map((meta) => ({
      alias: meta.alias,
      ref: { kind: "dataset", id: meta.datasetId },
    })),
    base: "states",
    steps,
    output: { fields: [], emptyFields: "keep" },
  };
}

function joinItems(multiMatch: JoinStep["multiMatch"], overrides: Partial<JoinStep> = {}): Step {
  return join({
    right: { input: "items" },
    on: [{ left: "id", right: "k" }],
    matching: noNormalization,
    multiMatch,
    ...overrides,
  });
}

let db: PGlite;
let alphaId: string;

beforeAll(async () => {
  db = await createDb();
  const states = await addRows(db, STATES, [
    { id: "1", name: "Alpha" },
    { id: "2", name: "Beta" },
    { id: "3", name: "Gamma" },
  ]);
  alphaId = states[0];
  await setGeom(db, alphaId, "POINT(1 1)");
  await addRows(db, ITEMS, [
    { k: "1", name: "x", type: "docs", url: "u1", cost: 10 },
    { k: "1", name: "y", type: "benefits", url: "u2", cost: 30 },
    { k: "1", name: "z", type: "docs", url: "u3", cost: null },
    { k: "2", name: "w", type: "docs", url: "u4", cost: 5 },
    { k: "99", name: "v1", type: "docs", url: "u5", cost: 1 },
    { k: "99", name: "v2", type: "docs", url: "u6", cost: 2 },
  ]);
  await addRows(db, TAGS, [
    { item: "x", tag: "red" },
    { item: "x", tag: "blue" },
    { item: "y", tag: "red" },
    { item: "y", tag: "ignore" },
    { item: "w", tag: "ignore" },
  ]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

type Row = { row_id: string; d: Record<string, unknown>; geom: string | null };

async function rows(def: ViewDefinition, inputs = metas): Promise<Map<string, Row>> {
  const result = await runQuery<Row>(db, compileView(def, inputs));
  return new Map(result.map((row) => [String(row.d.name), row]));
}

describe("output renames", () => {
  test("a renamed key reads its source field; missing sources are omitted", async () => {
    const def = view([]);
    def.output = {
      fields: [{ key: "town", from: "name" }, { key: "id" }, { key: "gone", from: "nope" }],
      emptyFields: "keep",
    };
    const result = await runQuery<Row>(db, compileView(def, metas));
    const alpha = must(result.find((row) => row.d.town === "Alpha"));
    expect(alpha.d).toEqual({ town: "Alpha", id: "1" });
  });
});

describe("multi-match modes", () => {
  test("spread: declared columns, first row wins per category, missing -> null", async () => {
    const result = await rows(
      view([
        joinItems({
          mode: "spread",
          by: "type",
          value: "url",
          columns: [
            { category: "docs", as: "docsLink" },
            { category: "benefits", as: "benefitsLink" },
          ],
        }),
      ]),
    );
    expect(must(result.get("Alpha")).d).toMatchObject({ docsLink: "u1", benefitsLink: "u2" });
    expect(must(result.get("Beta")).d).toMatchObject({ docsLink: "u4", benefitsLink: null });
    expect(must(result.get("Gamma")).d).toMatchObject({ docsLink: null, benefitsLink: null });
  });

  test("spread diagnostics: undeclared categories", async () => {
    const def = view([
      joinItems({
        mode: "spread",
        by: "type",
        value: "url",
        columns: [{ category: "docs", as: "docsLink" }],
      }),
    ]);
    const [row] = await runQuery<{ diagnostics: { steps: { join: Record<string, unknown> }[] } }>(
      db,
      compileDiagnostics(def, metas),
    );
    expect(row.diagnostics.steps[0].join).toMatchObject({
      policy: "spread",
      spread: { undeclaredCategories: ["benefits"], undeclaredRows: 1 },
    });
  });

  test("text: string_agg in row order with a separator; unmatched -> null", async () => {
    const result = await rows(view([joinItems({ mode: "text", field: "name", separator: " | " })]));
    expect(must(result.get("Alpha")).d["items.name"]).toBe("x | y | z");
    expect(must(result.get("Beta")).d["items.name"]).toBe("w");
    expect(must(result.get("Gamma")).d["items.name"]).toBeNull();
  });

  test("list: opt-in arrays of whole rows or chosen fields; unmatched -> []", async () => {
    const whole = await rows(view([joinItems({ mode: "list" })]));
    const items = must(whole.get("Alpha")).d.items as Record<string, unknown>[];
    expect(items.map((item) => item.name)).toEqual(["x", "y", "z"]);
    expect(must(whole.get("Gamma")).d.items).toEqual([]);
    const picked = await rows(
      view([joinItems({ mode: "list" }, { fields: ["name", "cost"], prefix: "found" })]),
    );
    expect(must(picked.get("Beta")).d.found).toEqual([{ name: "w", cost: 5 }]);
  });

  test("error: unique keys pass through like first", async () => {
    const result = await rows(
      view([
        joinItems({ mode: "error" }, { on: [{ left: "name", right: "name" }], fields: ["url"] }),
      ]),
    );
    expect(result.size).toBe(3);
    expect(must(result.get("Alpha")).d).toEqual({ id: "1", name: "Alpha" });
  });

  test("error: a key with several matches aborts the run and names the key", async () => {
    const run = runQuery(db, compileView(view([joinItems({ mode: "error" })]), metas));
    await expect(run).rejects.toThrow(/Multiple rows match the join key: 1/);
  });

  test("error: duplicate keys with no left row do not trip the guard", async () => {
    const def = view([
      { kind: "filter", where: { field: "id", op: "eq", value: "2" } },
      joinItems({ mode: "error" }),
    ]);
    const result = await rows(def);
    expect(must(result.get("Beta")).d).toMatchObject({ "items.name": "w" });
  });

  test("error: diagnostics report the conflicting key count instead of failing", async () => {
    const [row] = await runQuery<{ diagnostics: { steps: { join: Record<string, unknown> }[] } }>(
      db,
      compileDiagnostics(view([joinItems({ mode: "error" })]), metas),
    );
    expect(row.diagnostics.steps[0].join).toMatchObject({ policy: "error", multiMatchKeys: 1 });
  });
});

describe("measures", () => {
  test("topBy max / min (empty values sort last) and the text measure", async () => {
    const result = await rows(
      view([
        joinItems({
          mode: "summarize",
          measures: [
            { as: "priciest", fn: "topBy", field: "name", by: "cost", direction: "max" },
            { as: "cheapest", fn: "topBy", field: "name", by: "cost", direction: "min" },
            { as: "names", fn: "text", field: "name", separator: ", " },
          ],
        }),
      ]),
    );
    expect(must(result.get("Alpha")).d).toMatchObject({
      priciest: "y",
      cheapest: "x",
      names: "x, y, z",
    });
    expect(must(result.get("Gamma")).d).toMatchObject({
      priciest: null,
      cheapest: null,
      names: null,
    });
  });

  test("groupBy supports topBy and text too", async () => {
    const def: ViewDefinition = {
      ...view([
        {
          kind: "groupBy",
          by: ["k"],
          measures: [
            { as: "top", fn: "topBy", field: "name", by: "cost" },
            { as: "all", fn: "text", field: "name", separator: "+" },
          ],
        },
      ]),
      base: "items",
    };
    const result = await runQuery<{ d: Record<string, unknown> }>(db, compileView(def, metas));
    const byKey = new Map(result.map((row) => [String(row.d.k), row.d]));
    expect(byKey.get("1")).toMatchObject({ top: "y", all: "x+y+z" });
    expect(byKey.get("99")).toMatchObject({ top: "v2", all: "v1+v2" });
  });
});

describe("inline sub-pipelines", () => {
  test("a sub-pipeline's join can have its own sub-pipeline", async () => {
    const tagsJoin = join({
      right: {
        input: "tags",
        steps: [{ kind: "filter", where: { field: "tag", op: "neq", value: "ignore" } }],
      },
      on: [{ left: "name", right: "item" }],
      multiMatch: { mode: "summarize", measures: [{ as: "tagCount", fn: "count" }] },
    });
    const outer = joinItems(
      {
        mode: "summarize",
        measures: [
          { as: "n", fn: "count" },
          { as: "mostTagged", fn: "topBy", field: "name", by: "tagCount" },
        ],
      },
      { right: { input: "items", steps: [tagsJoin] } },
    );
    const result = await rows(view([outer]));
    // x has 2 tags, y 1 (the "ignore" tag is filtered out), z none.
    expect(must(result.get("Alpha")).d).toEqual({ id: "1", name: "Alpha", n: 3, mostTagged: "x" });
    expect(must(result.get("Beta")).d).toEqual({ id: "2", name: "Beta", n: 1, mostTagged: "w" });
    expect(must(result.get("Gamma")).d).toEqual({ id: "3", name: "Gamma", n: 0, mostTagged: null });
  });

  test("two sub-pipelines in one view keep their CTE names apart", async () => {
    const sub: Step[] = [{ kind: "filter", where: { field: "cost", op: "gt", value: 4 } }];
    const result = await rows(
      view([
        joinItems(
          { mode: "summarize", measures: [{ as: "big", fn: "count" }] },
          { right: { input: "items", steps: sub } },
        ),
        joinItems(
          { mode: "summarize", measures: [{ as: "all", fn: "count" }] },
          { right: { input: "items" } },
        ),
      ]),
    );
    expect(must(result.get("Alpha")).d).toMatchObject({ big: 2, all: 3 });
  });
});

describe("calculate", () => {
  const typed: CompileInputMeta[] = [
    {
      alias: "states",
      datasetId: STATES,
      title: "States",
      fields: [
        { name: "a", type: "number" },
        { name: "b", type: "integer" },
        { name: "s", type: "string" },
        { name: "t", type: "date" },
        { name: "flag", type: "boolean" },
        { name: "name", type: "string" },
      ],
    },
    ...metas.slice(1),
  ];
  const untyped: CompileInputMeta[] = [
    {
      alias: "states",
      datasetId: STATES,
      title: "States",
      fields: ["a", "b", "s", "t", "flag", "name"].map((name) => ({ name })),
    },
    ...metas.slice(1),
  ];
  const cases: [string, unknown][] = [
    ["a + b * 2", 14],
    ["(a + b) / 2", 5],
    ["a / 0", null],
    ["round(a / 4, 1)", 1.5],
    ["round(7.5)", 8],
    ["upper(trim(s))", "HI THERE"],
    ["lower(trim(s))", "hi there"],
    ["concat(trim(s), '-', a)", "Hi There-6"],
    ["year(t)", 2024],
    ["month(t)", 3],
    ["day(t)", 15],
    ["if(a > b, 'big', 'small')", "big"],
    ["case when a > 10 then 'x' when a > 5 then 'mid' else 'low' end", "mid"],
    ["case when a > 10 then 'x' end", null],
    ["a > b and flag", true],
    ["not flag or a = 6", true],
    ["a != 6", false],
    ["-a", -6],
    ["a - -b", 10],
    ["a is null", false],
    ["a is not null", true],
    ["coalesce(a, 1)", 6],
    ["'it''s'", "it's"],
    ["name = 'Alpha'", true],
    ["null", null],
  ];

  async function evaluate(inputs: CompileInputMeta[]): Promise<Record<string, unknown>> {
    const steps: Step[] = cases.map(([expr], i) => ({
      kind: "calculate",
      field: `f${i}`,
      expr,
    }));
    // The states rows carry a, b, s, t, flag through a first calculate-free seed.
    await db.query(
      "update public.entries set data = data || $1::jsonb where dataset_id = $2 and data->>'id' = '1'",
      [JSON.stringify({ a: 6, b: 4, s: "  Hi There ", t: "2024-03-15", flag: true }), STATES],
    );
    const result = await runQuery<Row>(db, compileView(view(steps), inputs));
    const alpha = result.find((row) => row.d.name === "Alpha");
    if (alpha === undefined) {
      throw new Error("Alpha missing");
    }
    return alpha.d;
  }

  test("typed field refs", async () => {
    const d = await evaluate(typed);
    expect(cases.map(([expr], i) => [expr, d[`f${i}`]])).toEqual(cases);
  });

  test("untyped field refs are coerced where used", async () => {
    const d = await evaluate(untyped);
    expect(cases.map(([expr], i) => [expr, d[`f${i}`]])).toEqual(cases);
  });

  test("missing values propagate as null instead of failing", async () => {
    const def = view([
      { kind: "calculate", field: "x", expr: "a * 2" },
      { kind: "calculate", field: "y", expr: "year(t)" },
      { kind: "calculate", field: "z", expr: "concat(name, a)" },
    ]);
    const result = await rows(def, typed);
    expect(must(result.get("Beta")).d).toMatchObject({ x: null, y: null, z: "Beta" });
  });
});

describe("sql step", () => {
  test("plain columns fold into d; geometry is dropped without a geom column", async () => {
    const result = await rows(
      view([
        {
          kind: "sql",
          query:
            "select p.d ->> 'name' as name, (p.d ->> 'id')::int * 10 as tens from prev p where p.d ->> 'id' <> '3'",
        },
      ]),
    );
    expect([...result.keys()].toSorted()).toEqual(["Alpha", "Beta"]);
    expect(must(result.get("Alpha")).d).toEqual({ name: "Alpha", tens: 10 });
    expect(must(result.get("Alpha")).geom).toBeNull();
  });

  test("a bad shape: unnamed columns and duplicate names are rejected", () => {
    const step: Step = { kind: "sql", query: "select p.d ->> 'name' from prev p" };
    expect(() => compileView(view([step]), metas)).toThrow(
      /name every output column|name with `as`/i,
    );
    const dup: Step = { kind: "sql", query: "select 1 as a, 2 as a from prev" };
    expect(() => compileView(view([dup]), metas)).toThrow(/Duplicate/);
  });

  test("select * from prev keeps row_id, d and geom", async () => {
    const result = await rows(
      view([{ kind: "sql", query: "select * from prev where d ->> 'id' = '1'" }]),
    );
    expect([...result.keys()]).toEqual(["Alpha"]);
    expect(must(result.get("Alpha")).geom).toBe("POINT(1 1)");
    expect(must(result.get("Alpha")).row_id).toBe(alphaId);
  });

  test("d + row_id + geom columns, extras merged into d, other inputs readable", async () => {
    const result = await rows(
      view([
        {
          kind: "sql",
          query: `select p.row_id, p.d || jsonb_build_object('items', (select count(*) from in_items)) as d, p.geom,
            length(p.d ->> 'name') as len
          from prev p;`,
        },
      ]),
    );
    expect(must(result.get("Alpha")).d).toMatchObject({ name: "Alpha", items: 6, len: 5 });
    expect(must(result.get("Alpha")).geom).toBe("POINT(1 1)");
  });

  test("rows without a row_id column get distinct deterministic ids", async () => {
    const def = view([{ kind: "sql", query: "select 1 as one from prev" }]);
    const first = await runQuery<Row>(db, compileView(def, metas));
    const second = await runQuery<Row>(db, compileView(def, metas));
    const ids = first.map((row) => row.row_id);
    expect(new Set(ids).size).toBe(3);
    expect(second.map((row) => row.row_id).toSorted()).toEqual(ids.toSorted());
  });

  test("a sql step can follow a join and feed another step", async () => {
    const result = await rows(
      view([
        joinItems({ mode: "summarize", measures: [{ as: "n", fn: "count" }] }),
        {
          kind: "sql",
          query: "select * from prev p where (p.d ->> 'n')::int > 0 order by p.d ->> 'name'",
        },
        { kind: "calculate", field: "double", expr: "n * 2" },
      ]),
    );
    expect([...result.keys()].toSorted()).toEqual(["Alpha", "Beta"]);
    expect(must(result.get("Alpha")).d).toMatchObject({ n: 3, double: 6 });
  });

  test("a sql step inside a sub-pipeline sees that chain's prev", async () => {
    const sub: Step[] = [
      { kind: "sql", query: "select * from prev p where (p.d ->> 'cost')::numeric >= 10" },
    ];
    const result = await rows(
      view([
        joinItems(
          { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
          { right: { input: "items", steps: sub } },
        ),
      ]),
    );
    expect(must(result.get("Alpha")).d).toMatchObject({ n: 2 });
    expect(must(result.get("Beta")).d).toMatchObject({ n: 0 });
  });

  test.each([
    ["delete from prev", /Only SELECT/],
    ["with x as (delete from prev returning *) select * from x", /Only SELECT/],
    ["select * from entries", /Unknown table/],
    ["select * from prev; select 2", /Only one statement/],
  ])("rejected query never reaches SQL: %s", (query, message) => {
    expect(() => compileView(view([{ kind: "sql", query }]), metas)).toThrow(message);
  });
});

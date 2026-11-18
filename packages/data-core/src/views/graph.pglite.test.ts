import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { compileDiagnostics, compileView } from "./compile.js";
import { nodeFields } from "./node-fields.js";
import { addRows, createDb, must, runQuery } from "./test-fixtures-pglite.js";
import { noNormalization } from "./test-fixtures.js";
import type { CompileInputMeta, ViewDefinition, ViewNode } from "./types.js";
import { validateViewDefinition } from "./validate.js";

const D1 = "bbbbbbbb-0000-4000-8000-000000000001";
const D2 = "bbbbbbbb-0000-4000-8000-000000000002";
const D3 = "bbbbbbbb-0000-4000-8000-000000000003";
const D4 = "bbbbbbbb-0000-4000-8000-000000000004";

const metas: CompileInputMeta[] = [
  {
    node: "d1",
    datasetId: D1,
    title: "D1",
    fields: [{ name: "state_id" }, { name: "Round" }, { name: "Amount" }, { name: "junk" }],
  },
  {
    node: "d2",
    datasetId: D2,
    title: "D2",
    fields: [{ name: "state_id" }, { name: "FY2_Round" }, { name: "Amount" }, { name: "junk" }],
  },
  {
    node: "d3",
    datasetId: D3,
    title: "D3",
    fields: [{ name: "state_id" }, { name: "Round" }, { name: "Amount" }],
  },
  {
    node: "d4",
    datasetId: D4,
    title: "D4",
    fields: [{ name: "state_id" }, { name: "state_name" }],
  },
];

const sources: Record<string, ViewNode> = {
  d1: { kind: "source", ref: { kind: "dataset", id: D1 } },
  d2: { kind: "source", ref: { kind: "dataset", id: D2 } },
  d3: { kind: "source", ref: { kind: "dataset", id: D3 } },
  d4: { kind: "source", ref: { kind: "dataset", id: D4 } },
};

/** The owner's example: d1 -> clean, d2 -> clean, stack with d3, clean, join d4. */
const owner: ViewDefinition = {
  nodes: {
    ...sources,
    d1c: {
      kind: "calculate",
      from: "d1",
      fields: [
        { field: "Round", expr: "number(replace(Round, 'Round ', ''))" },
        { field: "Amount", expr: "number(replace(replace(Amount, '$', ''), ',', ''))" },
      ],
    },
    d2c: {
      kind: "columns",
      from: "d2",
      edits: [
        { from: "FY2_Round", as: "Round" },
        { from: "junk", exclude: true },
      ],
    },
    stack1: {
      kind: "stack",
      tagField: "fiscal_year",
      inputs: [
        { node: "d1c", tag: 2022, columns: [{ from: "junk", exclude: true }] },
        { node: "d2c", tag: 2023 },
        { node: "d3", tag: 2024 },
      ],
    },
    stack1c: {
      kind: "calculate",
      from: "stack1",
      fields: [{ field: "Yes_No", expr: "if(Round = 1, 'Yes', 'No')" }],
    },
    out: {
      kind: "join",
      left: "stack1c",
      right: "d4",
      on: [{ left: "state_id", right: "state_id" }],
      matching: noNormalization,
      type: "left",
      multiMatch: { mode: "first" },
      prefix: "st",
    },
  },
  result: { node: "out", output: { fields: [], emptyFields: "keep" } },
};

let db: PGlite;
let geomRow: string;

type Row = { row_id: string; d: Record<string, unknown>; geom: string | null };

beforeAll(async () => {
  db = await createDb();
  const d1 = await addRows(db, D1, [
    { state_id: "KS", Round: "Round 1", Amount: "$1,200", junk: "x" },
    { state_id: "IA", Round: "Round 2", Amount: "$30", junk: "y" },
  ]);
  geomRow = must(d1[0]);
  await db.query("insert into public.geometries (entry_id, geom) values ($1, 'POINT(1 1)')", [
    geomRow,
  ]);
  await addRows(db, D2, [{ state_id: "KS", FY2_Round: 2, Amount: 500, junk: "z" }]);
  await addRows(db, D3, [{ state_id: "NE", Round: 1, Amount: 7 }]);
  await addRows(db, D4, [
    { state_id: "KS", state_name: "Kansas" },
    { state_id: "IA", state_name: "Iowa" },
  ]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("the owner's d1..d4 graph", () => {
  test("validates", () => {
    expect(validateViewDefinition(owner, metas)).toEqual({ ok: true, value: owner });
  });

  test("cleans per source, stacks with tags, cleans the stack, joins", async () => {
    const rows = await runQuery<Row>(db, compileView(owner, metas));
    expect(rows).toHaveLength(4);
    const byYear = (year: number, state: string): Row =>
      must(rows.find((r) => r.d.fiscal_year === year && r.d.state_id === state));
    expect(byYear(2022, "KS").d).toMatchObject({
      Round: 1,
      Amount: 1200,
      Yes_No: "Yes",
      "st.state_name": "Kansas",
    });
    expect("junk" in byYear(2022, "KS").d).toBe(false);
    expect(byYear(2023, "KS").d).toMatchObject({ Round: 2, Amount: 500, Yes_No: "No" });
    expect("junk" in byYear(2023, "KS").d).toBe(false);
    expect(byYear(2024, "NE").d).toMatchObject({ Round: 1, Yes_No: "Yes" });
    expect("st.state_name" in byYear(2024, "NE").d).toBe(false);
  });

  test("geometry travels through the stack and the join", async () => {
    const rows = await runQuery<Row>(db, compileView(owner, metas));
    expect(must(rows.find((r) => r.d.fiscal_year === 2022 && r.d.state_id === "KS")).geom).toBe(
      "POINT(1 1)",
    );
    expect(rows.filter((r) => r.geom !== null)).toHaveLength(1);
  });

  test("a node can be read twice (shared) and uptoNode previews one node", async () => {
    const shared: ViewDefinition = {
      nodes: {
        ...owner.nodes,
        both: {
          kind: "stack",
          inputs: [{ node: "d1c" }, { node: "d1c" }],
        },
      },
      result: { node: "both", output: owner.result.output },
    };
    expect(await runQuery<Row>(db, compileView(shared, metas))).toHaveLength(4);
    const preview = await runQuery<Row>(db, compileView(owner, metas, { uptoNode: "d1c" }));
    expect(preview).toHaveLength(2);
    expect(compileView(owner, metas, { uptoNode: "d1c" }).sql).not.toContain("in_d4");
  });

  test("unreachable nodes do not compile", () => {
    const extra: ViewDefinition = {
      ...owner,
      nodes: {
        ...owner.nodes,
        orphan: { kind: "filter", from: "d3", where: { field: "x", op: "notNull" } },
      },
    };
    expect(compileView(extra, metas).sql).not.toContain("orphan");
  });

  test("diagnostics report per node, dependencies first", async () => {
    const [row] = await runQuery<{
      diagnostics: { nodes: { id: string; rowsIn: number; rowsOut: number }[] };
    }>(db, compileDiagnostics(owner, metas));
    const ids = row.diagnostics.nodes.map((n) => n.id);
    expect(ids.indexOf("d1")).toBeLessThan(ids.indexOf("d1c"));
    expect(ids.indexOf("stack1")).toBeLessThan(ids.indexOf("stack1c"));
    expect(ids.at(-1)).toBe("out");
    expect(must(row.diagnostics.nodes.find((n) => n.id === "stack1"))).toMatchObject({
      rowsIn: 4,
      rowsOut: 4,
    });
  });
});

describe("columns and calculate nodes", () => {
  test("a columns node renames and drops many columns, and `only` keeps and filters", async () => {
    const def: ViewDefinition = {
      nodes: {
        ...sources,
        c: {
          kind: "columns",
          from: "d1",
          edits: [
            { from: "Round", as: "round" },
            { from: "junk", exclude: true },
          ],
          only: ["state_id", "round"],
        },
      },
      result: { node: "c", output: { fields: [], emptyFields: "keep" } },
    };
    expect(validateViewDefinition(def, metas).ok).toBe(true);
    const rows = await runQuery<Row>(db, compileView(def, metas));
    expect(
      rows.map((r) => r.d).toSorted((a, b) => String(a.state_id).localeCompare(String(b.state_id))),
    ).toEqual([
      { state_id: "IA", round: "Round 2" },
      { state_id: "KS", round: "Round 1" },
    ]);
  });

  test("calculate fields evaluate in order; replace keeps null", async () => {
    const def: ViewDefinition = {
      nodes: {
        ...sources,
        c: {
          kind: "calculate",
          from: "d1",
          fields: [
            { field: "n", expr: "number(replace(Round, 'Round ', ''))" },
            { field: "double", expr: "n * 2" },
            { field: "none", expr: "replace(missing, 'a', 'b')" },
          ],
        },
      },
      result: { node: "c", output: { fields: [], emptyFields: "keep" } },
    };
    const rows = await runQuery<Row>(
      db,
      compileView(def, [
        ...metas.slice(1),
        { ...metas[0], fields: [...(metas[0].fields ?? []), { name: "missing" }] },
      ]),
    );
    const ks = must(rows.find((r) => r.d.state_id === "KS"));
    expect(ks.d).toMatchObject({ n: 1, double: 2, none: null });
  });
});

describe("structure errors", () => {
  const cyclic: ViewDefinition = {
    nodes: {
      ...sources,
      a: { kind: "filter", from: "b", where: { field: "x", op: "notNull" } },
      b: { kind: "filter", from: "a", where: { field: "x", op: "notNull" } },
    },
    result: { node: "a", output: { fields: [], emptyFields: "keep" } },
  };

  test("cycles are a readable error in the validator and the compiler", () => {
    const result = validateViewDefinition(cyclic, metas);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('Node \\"a\\" reads itself: a → b → a');
    expect(() => compileView(cyclic, metas)).toThrow('Node "a" reads itself: a → b → a');
  });

  test("a missing reference, an empty result and bad ids are structural errors", () => {
    const missing = validateViewDefinition(
      {
        nodes: {
          ...sources,
          f: { kind: "filter", from: "ghost", where: { field: "x", op: "notNull" } },
        },
        result: { node: "f", output: { fields: [], emptyFields: "keep" } },
      },
      metas,
    );
    expect(missing).toMatchObject({
      ok: false,
      errors: [{ path: "nodes.f.from", message: 'Unknown node "ghost".' }],
    });
    const noResult = validateViewDefinition({
      nodes: sources,
      result: { node: "", output: { fields: [], emptyFields: "keep" } },
    });
    expect(noResult.ok).toBe(false);
    const badId = validateViewDefinition({
      nodes: { "Bad Id": sources.d1 },
      result: { node: "Bad Id", output: { fields: [], emptyFields: "keep" } },
    });
    expect(badId.ok).toBe(false);
  });

  test("stack and column-edit problems point at the node path", () => {
    const def: ViewDefinition = {
      nodes: {
        ...sources,
        st: {
          kind: "stack",
          inputs: [
            { node: "d1", columns: [{ from: "nope", as: "x" }] },
            { node: "d3", tag: 1 },
          ],
        },
      },
      result: { node: "st", output: { fields: [], emptyFields: "keep" } },
    };
    const result = validateViewDefinition(def, metas);
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.errors.map((e) => e.path);
    expect(paths).toContain("nodes.st.tagField");
    const defFixed = {
      ...def,
      nodes: { ...def.nodes, st: { ...def.nodes.st, tagField: "fy" } as ViewNode },
    };
    const fixed = validateViewDefinition(defFixed, metas);
    expect(fixed.ok ? [] : fixed.errors.map((e) => e.path)).toEqual([
      "nodes.st.inputs[0].columns[0]",
    ]);
  });
});

describe("replace and number at run time", () => {
  test("text cleanup feeds numbers; null stays null; non-numbers are empty", async () => {
    const def: ViewDefinition = {
      nodes: {
        ...sources,
        c: {
          kind: "calculate",
          from: "d1",
          fields: [
            { field: "amount", expr: "number(replace(replace(Amount, '$', ''), ',', ''))" },
            { field: "bad", expr: "number(state_id)" },
          ],
        },
      },
      result: { node: "c", output: { fields: [], emptyFields: "keep" } },
    };
    const rows = await runQuery<Row>(db, compileView(def, metas));
    const ks = must(rows.find((r) => r.d.state_id === "KS"));
    expect(ks.d).toMatchObject({ amount: 1200, bad: null });
  });
});

describe("sql nodes and node fields", () => {
  test("a sql node may read `in_<from>` as well as prev and its reads", async () => {
    const def: ViewDefinition = {
      nodes: {
        ...sources,
        q: {
          kind: "sql",
          from: "d1",
          reads: ["d4"],
          query:
            "select (select count(*) from in_d1) as a, (select count(*) from in_d4) as b, (select count(*) from prev) as c limit 1",
        },
      },
      result: { node: "q", output: { fields: [], emptyFields: "keep" } },
    };
    expect(validateViewDefinition(def, metas).ok).toBe(true);
    const rows = await runQuery<Row>(db, compileView(def, metas));
    expect(rows[0].d).toMatchObject({ a: 2, b: 2, c: 2 });
    const undeclared = { ...def, nodes: { ...def.nodes, q: { ...def.nodes.q, reads: [] } } };
    expect(validateViewDefinition(undeclared, metas).ok).toBe(false);
  });

  test("nodeFields reports each node's fields, unknown where the shape is", () => {
    const fields = nodeFields(owner, metas);
    expect([...must(fields.get("d2c")).keys()]).toEqual(["state_id", "Amount", "Round"]);
    expect(must(fields.get("d1c")).get("Round")).toBe("number");
    expect(nodeFields({ nodes: { s: sources.d1 } }, []).get("s")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { transformSpecDependencies } from "./spec.js";
import type { SqlOperation } from "./spec.js";
import { applySql, declaredColumnTypes, materializeSqlTable, sqlSourceName } from "./sql.js";
import type { SqlColumnSpec, SqlEngine, SqlTable } from "./sql.js";

// The PoC join domain (app/convex/schema.ts locations/restaurants) — the
// analysis layer's "how many restaurants in each state" example.
const locations = [
  { state: "CA", label: "A", lat: 34.05, lng: -118.24 },
  { state: "ca", label: "B", lat: 37.77, lng: -122.42 },
  { state: 42, label: "C", lat: 40.71, lng: -74.0 },
  { state: "  42  ", label: "D", lat: 41.88, lng: -87.63 },
];

const DECLARED: SqlColumnSpec[] = [
  { name: "state", type: "string" },
  { name: "lat", type: "number" },
];

describe("declaredColumnTypes — the declared structure's read", () => {
  it('maps the import-time inference shapes (string and [T, "null"] array forms)', () => {
    expect(
      declaredColumnTypes({
        properties: {
          grantId: { type: "string" },
          amount: { type: "number" },
          count: { type: "integer" },
          active: { type: "boolean" },
          note: { type: ["string", "null"] },
        },
      }),
    ).toStrictEqual([
      { name: "grantId", type: "string" },
      { name: "amount", type: "number" },
      { name: "count", type: "number" },
      { name: "active", type: "boolean" },
      { name: "note", type: "string" },
    ]);
  });

  it("omits non-scalar declared types and tolerates a schemaless document", () => {
    expect(declaredColumnTypes({ properties: { meta: { type: "object" } } })).toStrictEqual([]);
    expect(declaredColumnTypes("not a schema")).toStrictEqual([]);
    expect(declaredColumnTypes(undefined)).toStrictEqual([]);
  });
});

describe("materializeSqlTable — 0.4 coercion policies at registration", () => {
  it("types columns from the declared structure, coercing cells through the shared policies", () => {
    const table = materializeSqlTable("source", locations, DECLARED);
    expect(table.name).toBe("source");
    expect(table.columns).toStrictEqual([
      { name: "state", type: "string" },
      { name: "lat", type: "number" },
      { name: "label", type: "string" }, // undeclared → inferred (strings)
      { name: "lng", type: "number" }, // undeclared → inferred (all numeric)
      { name: "state__key", type: "string" }, // the canonical twin (#133 item 9)
      { name: "label__key", type: "string" },
    ]);
  });

  it("keeps the original text in a string column and collapses mixed-typed cells in its __key twin (#133 item 9)", () => {
    const table = materializeSqlTable("source", locations, DECLARED);
    expect(table.rows.map((row) => row.state)).toStrictEqual(["CA", "ca", "42", "  42  "]);
    expect(table.rows.map((row) => row.state__key)).toStrictEqual(["ca", "ca", "42", "42"]);
  });

  it('case-folds the canonical twin so "Aldine" and "aldine" group together — never numeric-normalizing "007"', () => {
    const table = materializeSqlTable(
      "source",
      [{ org: "Aldine" }, { org: "  aldine " }, { org: "007" }, { org: 7 }],
      [{ name: "org", type: "string" }],
    );
    expect(table.rows.map((row) => row.org)).toStrictEqual(["Aldine", "  aldine ", "007", "7"]);
    expect(table.rows.map((row) => row.org__key)).toStrictEqual(["aldine", "aldine", "007", "7"]);
  });

  it("names a twin with trailing underscores when the data already carries <col>__key (#133)", () => {
    const table = materializeSqlTable(
      "source",
      [
        { org: "A", org__key: "user-column" },
        { org: "a", org__key: "user-column-2" },
      ],
      [
        { name: "org", type: "string" },
        { name: "org__key", type: "string" },
      ],
    );
    // Visible columns first (the user's org__key untouched), then each
    // string column's twin — `org`'s twin yields the taken name and gains
    // an underscore, and `org__key` gets its own twin in turn.
    expect(table.columns.map((column) => column.name)).toStrictEqual([
      "org",
      "org__key",
      "org__key_",
      "org__key__key",
    ]);
    expect(table.rows[0]).toStrictEqual({
      org: "A",
      org__key: "user-column",
      org__key_: "a",
      org__key__key: "user-column",
    });
  });

  it("keeps a whitespace-only string as text with a null key — the keyless policy, visible not erased (#133 item 9)", () => {
    const table = materializeSqlTable(
      "source",
      [{ org: "   " }, { org: "Aldine" }],
      [{ name: "org", type: "string" }],
    );
    expect(table.rows.map((row) => row.org)).toStrictEqual(["   ", "Aldine"]);
    expect(table.rows.map((row) => row.org__key)).toStrictEqual([null, "aldine"]);
  });

  it('reads number columns through coerceNumber: "42" is 42, non-numeric is null — never 0', () => {
    const table = materializeSqlTable(
      "source",
      [{ amount: "42" }, { amount: " n/a " }, { amount: null }, {}],
      [{ name: "amount", type: "number" }],
    );
    expect(table.rows.map((row) => row.amount)).toStrictEqual([42, null, null, null]);
  });

  it('coerces "true"/"false" text case-insensitively in boolean columns (#133 item 12)', () => {
    const table = materializeSqlTable(
      "source",
      [{ active: "TRUE" }, { active: "false" }, { active: " False " }, { active: "yes" }],
      [{ name: "active", type: "boolean" }],
    );
    expect(table.rows.map((row) => row.active)).toStrictEqual([true, false, false, null]);
  });

  it("infers an all-null column as string, never number (#133 item 12)", () => {
    const table = materializeSqlTable("source", [{ ghost: null }, { ghost: undefined }], []);
    const ghost = table.columns.find((column) => column.name === "ghost");
    expect(ghost === undefined ? undefined : ghost.type).toBe("string");
    expect(table.rows.map((row) => row.ghost)).toStrictEqual([null, null]);
  });

  it("counts value-carrying cells that coerced to null (#133 item 12)", () => {
    const table = materializeSqlTable(
      "source",
      [
        { amount: "42" }, // fine
        { amount: " n/a " }, // coerced
        { amount: null }, // legitimately null — not counted
        {},
      ],
      [{ name: "amount", type: "number" }],
    );
    expect(table.coercedNulls).toBe(1);
  });

  it("never mutates its inputs — every materialized row is a fresh object", () => {
    const rowsIn = [{ state: "CA", lat: 1 }],
      frozen = JSON.parse(JSON.stringify(rowsIn));
    materializeSqlTable("source", rowsIn, DECLARED);
    expect(JSON.parse(JSON.stringify(rowsIn))).toStrictEqual(frozen);
  });
});

/** A stand-in engine recording what it was asked, answering scripted rows — the rollup.test.ts pattern. */
function fakeEngine(result: Array<Record<string, unknown>> | Error): SqlEngine & {
  registered: SqlTable[];
  queries: string[];
} {
  return {
    registered: [],
    queries: [],
    async register(table) {
      this.registered.push(table);
    },
    async query(sql) {
      this.queries.push(sql);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function sqlOp(overrides?: Partial<SqlOperation>): SqlOperation {
  return {
    kind: "sql",
    sql: "SELECT state, count(*) AS n FROM source GROUP BY state",
    tables: [],
    ...overrides,
  };
}

describe("applySql — the one engine interface, fourth argument the handle", () => {
  it('registers the source first (default name "source"), then side tables in spec order, and runs the query', async () => {
    const engine = fakeEngine([{ state: "ca", n: 2 }]),
      result = await applySql(
        sqlOp({ tables: [{ as: "restaurants", datasetId: "rest-1" }] }),
        locations,
        new Map([["restaurants", { rows: [{ id: "rest-1" }] }]]),
        engine,
      );
    expect(sqlSourceName(sqlOp())).toBe("source");
    expect(engine.registered.map((table) => table.name)).toStrictEqual(["source", "restaurants"]);
    expect(result.rows).toStrictEqual([{ state: "ca", n: 2 }]);
    expect(result.diagnostics).toStrictEqual({
      coercedNulls: 0,
      resultRows: 1,
      tables: ["source", "restaurants"],
      totalSourceRows: 4,
      truncated: false,
    });
  });

  it("never throws: a failed query is diagnostics.error with empty rows", async () => {
    // A SELECT-shaped query (past the statement gate) that the engine then
    // rejects — an unknown table is the user-typo case the never-throws
    // contract exists for.
    const result = await applySql(
      sqlOp({ sql: "SELECT * FROM no_such_table" }),
      locations,
      new Map(),
      fakeEngine(new Error("Catalog Error: Table no_such_table does not exist")),
    );
    expect(result.rows).toStrictEqual([]);
    expect(result.diagnostics.error).toContain("no_such_table");
  });

  it("rejects an empty query and duplicate table names before touching the engine", async () => {
    const engine = fakeEngine([]);
    const empty = await applySql(sqlOp({ sql: "   " }), locations, new Map(), engine);
    expect(empty.diagnostics.error).toContain("no SQL query");
    const dupe = await applySql(
      sqlOp({ sourceAs: "grants", tables: [{ as: "grants", datasetId: "g" }] }),
      locations,
      new Map(),
      engine,
    );
    expect(dupe.diagnostics.error).toContain("more than once");
    expect(engine.queries).toStrictEqual([]);
  });

  it("folds case in the duplicate-name gate — DuckDB identifiers are case-insensitive (#133 item 5)", async () => {
    const engine = fakeEngine([]);
    const dupe = await applySql(
      sqlOp({ sourceAs: "Grants", tables: [{ as: "grants", datasetId: "g" }] }),
      locations,
      new Map(),
      engine,
    );
    expect(dupe.diagnostics.error).toContain("more than once");
    expect(dupe.diagnostics.error).toContain("case-insensitive");
    expect(engine.queries).toStrictEqual([]);
    // Distinct names that merely differ in case from an UNRELATED word run fine.
    const ok = await applySql(
      sqlOp({ sourceAs: "Grants", tables: [{ as: "Grants2", datasetId: "g" }] }),
      locations,
      new Map(),
      engine,
    );
    expect(ok.diagnostics.error).toBeUndefined();
  });

  it("drops earlier runs' tables through an engine that implements retainTables (#133 item 1)", async () => {
    const dropped: Array<readonly string[]> = [];
    const engine = fakeEngine([{ n: 1 }]);
    engine.retainTables = async (names) => {
      dropped.push(names);
    };
    const first = await applySql(
      sqlOp({ tables: [{ as: "restaurants", datasetId: "g" }] }),
      locations,
      new Map([["restaurants", { rows: [{ id: "rest-1" }] }]]),
      engine,
    );
    expect(first.diagnostics.error).toBeUndefined();
    const second = await applySql(sqlOp(), locations, new Map(), engine);
    expect(second.diagnostics.error).toBeUndefined();
    // The second run names only its own tables — the engine drops the rest.
    expect(dropped).toStrictEqual([["source", "restaurants"], ["source"]]);
    // A stand-in without retainTables still runs (the optional hook).
    const bareEngine = fakeEngine([]);
    const bare = await applySql(sqlOp(), locations, new Map(), bareEngine);
    expect(bare.diagnostics.error).toBeUndefined();
  });

  it("truncates only when asked, and reports the pre-cap count", async () => {
    const many = [{ n: 1 }, { n: 2 }, { n: 3 }],
      capped = await applySql(sqlOp(), locations, new Map(), fakeEngine(many), { limit: 2 });
    expect(capped.rows).toStrictEqual([{ n: 1 }, { n: 2 }]);
    expect(capped.diagnostics.truncated).toBe(true);
    expect(capped.diagnostics.resultRows).toBe(3);
    const uncapped = await applySql(sqlOp(), locations, new Map(), fakeEngine(many));
    expect(uncapped.rows).toStrictEqual(many);
    expect(uncapped.diagnostics.truncated).toBe(false);
  });

  it("registers a ref whose side table has not streamed as an empty table (no fabricated error)", async () => {
    const engine = fakeEngine([]);
    await applySql(
      sqlOp({ tables: [{ as: "restaurants", datasetId: "rest-1" }] }),
      locations,
      new Map(),
      engine,
    );
    expect(engine.registered[1]).toStrictEqual({
      coercedNulls: 0,
      columns: [],
      name: "restaurants",
      rows: [],
    });
  });

  it("never throws on a stored op whose tables field is absent — legal per the save gate's tolerance, so the engine defaults", async () => {
    const engine = fakeEngine([{ n: 1 }]);
    const operation = sqlOp();
    const legacy = { kind: "sql", sql: operation.sql } as unknown as SqlOperation;
    const result = await applySql(legacy, locations, new Map(), engine);
    expect(result.rows).toStrictEqual([{ n: 1 }]);
    expect(result.diagnostics.tables).toStrictEqual(["source"]);
  });

  it("enforces the read-only statement gate: one SELECT/WITH statement, nothing else", async () => {
    const engine = fakeEngine([]);
    const nonSelect = await applySql(
      sqlOp({ sql: "DROP TABLE source" }),
      locations,
      new Map(),
      engine,
    );
    expect(nonSelect.diagnostics.error).toContain("read-only SELECT");
    const multi = await applySql(
      sqlOp({ sql: "SELECT 1; DROP TABLE source" }),
      locations,
      new Map(),
      engine,
    );
    expect(multi.diagnostics.error).toContain("one statement at a time");
    // Leading comments and whitespace are fine; a CTE is fine; a semicolon
    // inside a string literal does not read as a separator.
    for (const sql of [
      "-- count per state\nSELECT state FROM source",
      "/* leading */ WITH t AS (SELECT 1 AS n FROM source) SELECT n FROM t",
      "SELECT ';' FROM source",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each candidate runs against the same recording engine; the loop is the assertion table.
      const ok = await applySql(sqlOp({ sql }), locations, new Map(), engine);
      expect(ok.diagnostics.error).toBeUndefined();
    }
    expect(engine.queries.length).toBe(3);
  });

  it("rejects a comment-hidden second statement and a WITH chain whose main verb writes (#132)", async () => {
    const engine = fakeEngine([]);
    // The shipped scanner tracked quotes but not comments, so a quote
    // character inside a comment desynchronized it and the real second
    // statement after the separator slipped through.
    for (const sql of [
      "SELECT 1 /* ' */ ; DROP TABLE source",
      'SELECT 1 /* " */ ; DROP TABLE source',
      "SELECT 1 -- '\n; DROP TABLE source",
      // E'\'' holds one quote (backslash-escaped); the engine then really
      // runs the DROP — the gate must see it.
      "SELECT E'\\''; DROP TABLE source",
      // The main verb after the CTEs is checked too: the pinned engine
      // parses and executes WITH … DELETE/INSERT (probe-verified 2026-09-30).
      "WITH t AS (SELECT 1) DELETE FROM t",
      "WITH t AS (SELECT 1) INSERT INTO t VALUES (2)",
      "WITH t AS (SELECT 1) UPDATE t SET n = 2",
      "WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM a",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each candidate runs against the same recording engine; the loop is the assertion table.
      const rejected = await applySql(sqlOp({ sql }), locations, new Map(), engine);
      expect(rejected.diagnostics.error).toBeDefined();
    }
    expect(engine.queries).toStrictEqual([]);
  });

  it("scans quoted regions the engine also treats as opaque — dollar quoting, E-strings, doubled quotes", async () => {
    const engine = fakeEngine([]);
    // Single statements whose quoted regions hide semicolons, quotes and
    // comment openers scan clean (the engine runs them as one statement).
    for (const sql of [
      "SELECT $$; DROP TABLE x$$ AS s",
      "SELECT $tag$ ' ; /* still inside $tag$ AS s",
      "SELECT 'don''t; drop' FROM source",
      "SELECT E'\\'' AS s",
      // Trailing comments after the single statement are not a second one.
      "SELECT 1; -- done",
      "SELECT 1; /* done */",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- assertion table, same recording engine.
      const ok = await applySql(sqlOp({ sql }), locations, new Map(), engine);
      expect(ok.diagnostics.error).toBeUndefined();
    }
    // But the same dollar-quoting cannot smuggle a real second statement.
    const smuggled = await applySql(
      sqlOp({ sql: "SELECT $t$ ' $t$; DROP TABLE source" }),
      locations,
      new Map(),
      engine,
    );
    expect(smuggled.diagnostics.error).toContain("one statement at a time");
  });

  it("keeps legitimate WITH shapes and keyword-named columns accepted (#132)", async () => {
    const engine = fakeEngine([{ n: 1 }]);
    // Keyword-named columns are legal DuckDB without quoting (probe-verified
    // 2026-09-30) — the gate is verb- and structure-shaped, never a keyword
    // blacklist that would reject such analyses.
    for (const sql of [
      "WITH t AS (SELECT 1 AS n) SELECT n FROM t",
      "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b",
      "WITH RECURSIVE t AS (SELECT 1 AS n) SELECT n FROM t",
      "WITH t (n) AS (SELECT 1) SELECT n FROM t",
      "WITH t AS MATERIALIZED (SELECT 1) SELECT 1",
      "WITH t AS NOT MATERIALIZED (SELECT 1) SELECT 1",
      "SELECT delete, update FROM source",
      "/* leading /* nested */ still */ SELECT 1",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- assertion table, same recording engine.
      const ok = await applySql(sqlOp({ sql }), locations, new Map(), engine);
      expect(ok.diagnostics.error).toBeUndefined();
    }
  });
});

describe("SqlOperation in the spec union — serializable, walk-aware", () => {
  it("round-trips as serializable data — a saved query is plain data", () => {
    const spec = {
      sourceDatasetId: "locations",
      operations: [sqlOp({ tables: [{ as: "restaurants", datasetId: "restaurants" }] })],
    };
    expect(JSON.parse(JSON.stringify(spec))).toStrictEqual(spec);
  });

  it("contributes its table refs as dependency edges — the cycle walk, health walk, visibility gate, and press order all read these", () => {
    expect(
      transformSpecDependencies({
        sourceDatasetId: "locations",
        operations: [
          sqlOp({
            tables: [
              { as: "restaurants", datasetId: "restaurants" },
              { as: "again", datasetId: "restaurants" },
            ],
          }),
          { kind: "lookup", lookupDatasetId: "orgs", baseKey: "id", lookupKey: "id" },
        ],
      }),
    ).toStrictEqual(["locations", "restaurants", "orgs"]);
  });
});

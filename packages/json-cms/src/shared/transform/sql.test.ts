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
    ]);
  });

  it('groups mixed-typed string-column cells: 42 and "42" and "  42  " collapse to one key', () => {
    const table = materializeSqlTable("source", locations, DECLARED);
    const states = table.rows.map((row) => row.state);
    expect(states).toStrictEqual(["ca", "ca", "42", "42"]);
  });

  it('case-folds a grouping key so "Aldine" and "aldine" are one group — never numeric-normalizes "007"', () => {
    const table = materializeSqlTable(
      "source",
      [{ org: "Aldine" }, { org: "  aldine " }, { org: "007" }, { org: 7 }],
      [{ name: "org", type: "string" }],
    );
    expect(table.rows.map((row) => row.org)).toStrictEqual(["aldine", "aldine", "007", "7"]);
  });

  it('reads number columns through coerceNumber: "42" is 42, non-numeric is null — never 0', () => {
    const table = materializeSqlTable(
      "source",
      [{ amount: "42" }, { amount: " n/a " }, { amount: null }, {}],
      [{ name: "amount", type: "number" }],
    );
    expect(table.rows.map((row) => row.amount)).toStrictEqual([42, null, null, null]);
  });

  it('keeps booleans only in boolean columns; keyless cells are null, never "null"', () => {
    const table = materializeSqlTable(
      "source",
      [{ active: true }, { active: "yes" }, { active: 1 }],
      [{ name: "active", type: "boolean" }],
    );
    expect(table.rows.map((row) => row.active)).toStrictEqual([true, null, null]);
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
    expect(engine.registered[1]).toStrictEqual({ columns: [], name: "restaurants", rows: [] });
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

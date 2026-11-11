import { describe, expect, test } from "vitest";

import { analyzeSqlStep, rewritePrev } from "./sql-step.js";

const ALIASES = ["states", "deployments"];

function errors(query: string): string[] {
  const result = analyzeSqlStep(query, ALIASES);
  return result.ok ? [] : result.errors.map((error) => error.message);
}

function columnsOf(query: string): string[] {
  const result = analyzeSqlStep(query, ALIASES);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.analysis.columns;
}

describe("sql step: accepted queries", () => {
  test.each([
    "select * from prev",
    "select p.row_id, p.d, p.geom from prev p where p.d ->> 'a' = 'x' order by 1 limit 5",
    "with a as (select * from prev) select * from a",
    "select * from prev union all select * from in_states",
    "select p.d || jsonb_build_object('n', (select count(*) from in_deployments)) as d from prev p",
    "select e.value as v from prev p, jsonb_array_elements(p.d -> 'xs') e",
    "select count(*) as n from prev p join in_states s on s.row_id = p.row_id;",
    "values (1, 2)",
  ])("%s", (query) => {
    expect(errors(query)).toEqual([]);
  });

  test("a trailing semicolon and comments are tolerated", () => {
    expect(errors("select * from prev; -- done")).toEqual([]);
  });
});

describe("sql step: rejections", () => {
  test("DML and DDL", () => {
    expect(errors("delete from prev")[0]).toContain("Only SELECT");
    expect(errors("insert into prev values (1)")[0]).toContain("Only SELECT");
    expect(errors("update prev set d = '{}'")[0]).toContain("Only SELECT");
    expect(errors("drop table entries")[0]).toContain("Only SELECT");
    expect(errors("create table t (a int)")[0]).toContain("Only SELECT");
  });

  test("data-modifying CTEs", () => {
    const query = "with x as (delete from prev returning *) select * from x";
    expect(errors(query).join(" ")).toContain("Only SELECT");
    expect(
      errors("with x as (insert into t values (1) returning 1 as a) select * from x"),
    ).not.toEqual([]);
    expect(errors("with x as (update t set a = 1 returning a) select a from x")).not.toEqual([]);
  });

  test("tables other than prev, the declared inputs and the query's own CTEs", () => {
    expect(errors("select * from entries")[0]).toContain('Unknown table "entries"');
    expect(errors("select * from public.entries")[0]).toContain("Schema-qualified");
    expect(errors("select * from prev, secrets")[0]).toContain('"secrets"');
    expect(errors("select * from in_links")[0]).toContain('Unknown table "in_links"');
    expect(errors("select * from prev where exists (select 1 from pg_class)")[0]).toContain(
      "pg_class",
    );
    expect(errors("select * from information_schema.tables")[0]).toContain("Schema-qualified");
  });

  test("multiple statements", () => {
    expect(errors("select * from prev; select * from prev")[0]).toContain("Only one statement");
    expect(errors("select * from prev; delete from prev")[0]).toContain("Only one statement");
  });

  test("syntax errors carry a position", () => {
    const result = analyzeSqlStep("select from from", ALIASES);
    const [first] = result.ok ? [] : result.errors;
    expect(first.message).toContain("SQL syntax error");
    expect(first.start).toBeGreaterThan(0);
  });

  test("empty queries, parameters and locking clauses", () => {
    expect(errors("   ")[0]).toContain("empty");
    expect(errors("select $1 as x")[0]).toContain("parameters");
    expect(errors("select * from prev for update")).not.toEqual([]);
  });

  test("functions that run nested SQL, touch files or settings", () => {
    expect(errors("select set_config('statement_timeout', '0', true) as x")[0]).toContain(
      "set_config",
    );
    expect(errors("select pg_sleep(100) as x")[0]).toContain("pg_sleep");
    expect(
      errors("select query_to_xml('select * from entries', true, true, '') as x")[0],
    ).toContain("query_to_xml");
    expect(errors("select * from prev, pg_read_file('/etc/passwd') f")[0]).toContain(
      "pg_read_file",
    );
  });

  test("redefining reserved names", () => {
    expect(errors("with prev as (select 1 as a) select * from prev")[0]).toContain("reserved");
    expect(errors("with in_states as (select 1 as a) select * from in_states")[0]).toContain(
      "reserved",
    );
  });

  test("recursive CTEs are not supported", () => {
    expect(
      errors("with recursive r(n) as (select 1 union all select n + 1 from r) select * from r"),
    ).not.toEqual([]);
  });
});

describe("sql step: output shape", () => {
  test("columns are named from aliases, refs, casts and function calls", () => {
    expect(columnsOf("select p.row_id, p.d::jsonb, count(*) as n, lower(x) from prev p")).toEqual([
      "row_id",
      "d",
      "n",
      "lower",
    ]);
  });

  test("a wildcard over prev or an input expands to row_id, d, geom", () => {
    expect(columnsOf("select * from prev")).toEqual(["row_id", "d", "geom"]);
    expect(columnsOf("select s.* from in_states s")).toEqual(["row_id", "d", "geom"]);
    expect(columnsOf("select p.*, 1 as extra from prev p")).toEqual([
      "row_id",
      "d",
      "geom",
      "extra",
    ]);
  });

  test("a wildcard over a query's own CTE or subquery expands through it", () => {
    expect(columnsOf("with a as (select 1 as x, 2 as y) select * from a")).toEqual(["x", "y"]);
    expect(columnsOf("select * from (select 1 as q) t")).toEqual(["q"]);
    expect(columnsOf("select 1 as a union select 2 as a")).toEqual(["a"]);
  });

  test("unnamed expressions, duplicate names and unexpandable wildcards are rejected", () => {
    expect(errors("select 1 from prev")[0]).toContain("name");
    expect(errors("select 1 as a, 2 as a from prev")[0]).toContain("Duplicate");
    expect(errors("select * from generate_series(1, 3)")[0]).toContain("function call");
  });
});

describe("sql step: prev rewriting", () => {
  function rewritten(query: string): string {
    const result = analyzeSqlStep(query, ALIASES);
    if (!result.ok) {
      throw new Error("expected a valid query");
    }
    return rewritePrev(result.analysis, '"s3"');
  }

  test("an unaliased prev keeps its name as the alias", () => {
    expect(rewritten("select prev.d from prev")).toBe('select prev.d from "s3" as prev');
  });

  test("an aliased prev only swaps the table", () => {
    expect(rewritten("select p.d from prev p")).toBe('select p.d from "s3" p');
    expect(rewritten("select p.d from PREV as p")).toBe('select p.d from "s3" as p');
  });

  test("every reference is rewritten, including in subqueries; inputs are untouched", () => {
    const text = rewritten(
      "select p.d from prev p where p.row_id in (select row_id from prev) and exists (select 1 from in_states)",
    );
    expect(text).toBe(
      'select p.d from "s3" p where p.row_id in (select row_id from "s3" as prev) and exists (select 1 from in_states)',
    );
  });

  test("trailing semicolons and comments are dropped", () => {
    expect(rewritten("select * from prev ; -- bye")).toBe('select * from "s3" as prev');
  });
});

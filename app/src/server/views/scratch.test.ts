import { describe, expect, it } from "vitest";

import { aliasesFor, scratchPrelude, wrapScratch, type ScratchTable } from "./scratch";
import { guardScratchSql } from "./scratch-guard";

const table: ScratchTable = {
  name: "in_states",
  alias: "states",
  datasetId: "11111111-1111-4111-8111-111111111111",
  title: "States",
  kind: "source",
  fields: ["id"],
};

describe("aliasesFor", () => {
  it("slugifies titles and de-duplicates with a numeric suffix", () => {
    expect(aliasesFor(["Deployments 2024", "States", "states", "STATES!"])).toStrictEqual([
      "deployments_2024",
      "states",
      "states_2",
      "states_3",
    ]);
  });

  it("never yields an empty alias", () => {
    expect(aliasesFor(["???"])).toStrictEqual(["input"]);
  });
});

describe("scratch SQL layout", () => {
  it("exposes each table with the compiler's (row_id, d, geom) layout", () => {
    const prelude = scratchPrelude([table]);
    expect(prelude).toContain('"in_states" as (');
    expect(prelude).toContain("e.id as row_id, e.data as d, g.geom as geom");
    expect(prelude).toContain(`e.dataset_id = '${table.datasetId}'::uuid`);
  });

  it("wraps the user's SQL as a subquery, so a stacked statement cannot run", () => {
    const wrapped = wrapScratch([table], "select 1 -- trailing comment");
    expect(wrapped).toContain("select * from (\nselect 1 -- trailing comment\n) as scratch");
    expect(wrapScratch([], "select 1")).toBe("select * from (\nselect 1\n) as scratch");
  });

  it("refuses a malformed dataset id rather than splicing it", () => {
    expect(() => scratchPrelude([{ ...table, datasetId: "1'; drop table x; --" }])).toThrow(
      /Invalid dataset id/,
    );
  });
});

describe("guardScratchSql", () => {
  it("accepts a select and strips trailing semicolons", () => {
    expect(guardScratchSql("select 1;  ;")).toStrictEqual({ ok: true, sql: "select 1" });
    expect(guardScratchSql("with a as (select 1) select * from a").ok).toBe(true);
  });

  it("refuses empty input and data-modifying statements with a clear message", () => {
    expect(guardScratchSql("  ;").ok).toBe(false);
    for (const dml of [
      "delete from public.entries",
      "-- c\nINSERT INTO t values (1)",
      "update t set a = 1",
      "drop table t",
      "/* x */ truncate t",
    ]) {
      const result = guardScratchSql(dml);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toMatch(/read-only/);
    }
  });

  it("refuses functions a read-only transaction does not stop", () => {
    for (const sql of [
      "select set_config('request.jwt.claims', '{}', true)",
      "select pg_catalog.SET_CONFIG('a','b',false)",
      "select pg_sleep(100)",
      `select "set_config"('a','b',true)`,
      `select U&"set\\005fconfig"('a','b',true)`,
    ]) {
      expect(guardScratchSql(sql).ok).toBe(false);
    }
    expect(guardScratchSql("select my_set_config_x from t").ok).toBe(true);
  });
});

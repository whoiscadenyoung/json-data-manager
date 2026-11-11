import { validateViewDefinition } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import {
  definitionFromScratch,
  prunedInputs,
  referencedScratchTables,
  sqlReadsTable,
  type ScratchTableInfo,
} from "./view-model";

const tables: ScratchTableInfo[] = [
  {
    alias: "deployments",
    datasetId: "22222222-2222-4222-8222-222222222222",
    fields: ["stateId", "cost"],
    kind: "source",
    name: "in_deployments",
    title: "Deployments",
  },
  {
    alias: "states",
    datasetId: "11111111-1111-4111-8111-111111111111",
    fields: ["id", "name"],
    kind: "source",
    name: "in_states",
    title: "States",
  },
  {
    alias: "unused",
    datasetId: "33333333-3333-4333-8333-333333333333",
    fields: [],
    kind: "view",
    name: "in_unused",
    title: "Unused",
  },
];

const SQL = `select s.d->>'name' as name, count(*) as n
from in_states s join "in_deployments" x on x.d->>'stateId' = s.d->>'id'
group by 1;`;

describe("sqlReadsTable", () => {
  it("matches whole identifiers, bare or quoted, case-insensitively", () => {
    expect(sqlReadsTable("select * from IN_STATES", "in_states")).toBe(true);
    expect(sqlReadsTable('select * from "in_states"', "in_states")).toBe(true);
    expect(sqlReadsTable("select * from in_states_2", "in_states")).toBe(false);
    expect(sqlReadsTable("select * from my_in_states", "in_states")).toBe(false);
  });
});

describe("definitionFromScratch", () => {
  it("declares only the tables the query reads and keeps the query unchanged", () => {
    expect(referencedScratchTables(SQL, tables).map((t) => t.alias)).toStrictEqual([
      "deployments",
      "states",
    ]);
    const definition = definitionFromScratch(SQL, tables, "states");
    expect(definition.inputs.map((input) => input.alias)).toStrictEqual(["deployments", "states"]);
    expect(definition.base).toBe("states");
    expect(definition.steps).toStrictEqual([{ kind: "sql", query: SQL.replace(/;$/, "") }]);
    expect(validateViewDefinition(definition).ok).toBe(true);
  });

  it("refuses a query that reads no table, or a base it does not read", () => {
    expect(() => definitionFromScratch("select 1", tables, "states")).toThrow(/any table/);
    expect(() => definitionFromScratch(SQL, tables, "unused")).toThrow(/base/);
  });

  it("survives the editor's input pruning", () => {
    const definition = definitionFromScratch(SQL, tables, "states");
    expect(prunedInputs(definition).inputs).toHaveLength(2);
  });
});

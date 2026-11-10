// Integration test — the Views SQL compiler (#299, docs/views-design.md §6/§8)
// against the local Supabase Postgres. One join+summarize case is compiled by
// @caden/data-core/views and EXECUTED, then the rows and the diagnostics are
// checked. Same wire-client pattern as the other pg-*.int.test.ts files (the
// simple protocol has no bind params, so the compiler's positional $n::type
// placeholders are substituted with sqlLit() literals here; real callers bind
// them). Skips with a one-line message when the stack is unreachable.

import { compileDiagnostics, compileView } from "@caden/data-core/views";
import type { CompileInputMeta, ViewDefinition } from "@caden/data-core/views";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  ensureUsers,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

let session: PgSession | undefined;

function s(): PgSession {
  if (session === undefined) throw new Error("integration session not connected");
  return session;
}

beforeEach(async () => {
  if (dbUp() && !session) {
    session = await PgSession.connect(DB_URL);
    await ensureUsers(session);
  }
});

afterAll(async () => {
  if (session) await session.close();
  session = undefined;
});

afterEach(async () => {
  if (session) await session.rollbackIfOpen();
});

/** Substitute the compiler's `$n::type` placeholders with literals (simple-protocol stand-in for binding). */
function bind(sql: string, params: unknown[]): string {
  return sql.replaceAll(/\$(\d+)(?=::)/g, (_match, n: string) => sqlLit(params[Number(n) - 1]));
}

describe.skipIf(!dbUp())("views compiler — join + summarize against Postgres", () => {
  test("states left-join deployments summarized per state; diagnostics agree", async () => {
    const states = await createDataset(s(), { createdBy: ALICE, properties: ["id", "name"] });
    const deployments = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["stateId", "cost"],
    });
    try {
      const kansas = await addEntry(s(), states, { id: "1", name: "Kansas" });
      await addEntry(s(), states, { id: "2", name: "Iowa" });
      await addEntry(s(), states, { id: "3", name: "Nowhere" });
      await addEntry(s(), deployments, { stateId: "1", cost: 10 });
      await addEntry(s(), deployments, { stateId: "1", cost: 30 });
      await addEntry(s(), deployments, { stateId: "2", cost: 5 });
      await addEntry(s(), deployments, { stateId: "99", cost: 1 });
      await s().expectOk(
        `insert into public.geometries (dataset_id, entry_id, source, type, created_by)
         values (${sqlLit(states)}, ${sqlLit(kansas)}, '{"type": "Point", "coordinates": [1.0, 2.0]}'::jsonb, 'Point', ${sqlLit(ALICE)})`,
      );

      const metas: CompileInputMeta[] = [
        { alias: "states", datasetId: states, title: "States" },
        { alias: "deployments", datasetId: deployments, title: "Deployments" },
      ];
      const def: ViewDefinition = {
        inputs: [
          { alias: "states", ref: { kind: "dataset", id: states } },
          { alias: "deployments", ref: { kind: "dataset", id: deployments } },
        ],
        base: "states",
        steps: [
          {
            kind: "join",
            right: { input: "deployments" },
            on: [{ left: "id", right: "stateId" }],
            matching: { trim: true, caseFold: true, collapseSpace: true, stripDiacritics: true },
            type: "left",
            multiMatch: {
              mode: "summarize",
              measures: [
                { as: "deployments", fn: "count" },
                { as: "totalCost", fn: "sum", field: "cost", emptyValue: 0 },
              ],
            },
          },
        ],
        output: { fields: [], emptyFields: "keep" },
      };

      const rows = compileView(def, metas);
      const result = await s().expectOk(
        `select q.d->>'name' as name, (q.d->>'deployments')::int as deployments,
                (q.d->>'totalCost')::numeric as total, st_astext(q.geom) as wkt
         from (${bind(rows.sql, rows.params)}) q
         order by name`,
      );
      expect(result.map((r) => [r.name, r.deployments, r.total, r.wkt])).toEqual([
        ["Iowa", "1", "5", null],
        ["Kansas", "2", "40", "POINT(1 2)"],
        ["Nowhere", "0", "0", null],
      ]);

      const diag = compileDiagnostics(def, metas);
      const diagRows = await s().expectOk(bind(diag.sql, diag.params));
      const diagnostics = JSON.parse(diagRows[0].diagnostics ?? "null");
      const [step] = diagnostics.steps;
      expect(step).toMatchObject({
        index: 0,
        kind: "join",
        rowsIn: 3,
        rowsOut: 3,
        fieldsAdded: ["deployments", "totalCost"],
        fieldsRemoved: [],
        join: {
          leftMatched: 2,
          leftUnmatched: 1,
          leftUnmatchedSamples: ["3"],
          rightMatched: 3,
          rightUnmatched: 1,
          rightUnmatchedSamples: ["99"],
          multiMatchKeys: 1,
          policy: "summarize",
        },
      });
    } finally {
      await dropDatasets(s(), [states, deployments]);
    }
  });
});

// Integration test — the Views advanced steps (#302 compiler half) against the
// local Supabase Postgres: the design §5 worked example ("States enriched":
// a join whose right side is an inline sub-pipeline, summarize count + topBy,
// links spread by type) plus the calculate and sql steps, each compiled by
// @caden/data-core/views and EXECUTED. Same wire-client pattern as
// pg-views-compiler.int.test.ts (the simple protocol has no bind params, so
// the compiler's positional $n::type placeholders are substituted with
// sqlLit() literals; real callers bind them). Skips with a one-line message
// when the stack is unreachable.

import { compileDiagnostics, compileView, validateViewDefinition } from "@caden/data-core/views";
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

describe.skipIf(!dbUp())("views advanced steps against Postgres", () => {
  test("design §5: States enriched (sub-pipeline, topBy, spread) end to end", async () => {
    const states = await createDataset(s(), { createdBy: ALICE, properties: ["id", "name"] });
    const deployments = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["id", "name", "stateId"],
    });
    const agencies = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["deploymentId", "agencyId"],
    });
    const links = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["stateName", "type", "url"],
    });
    try {
      const kansas = await addEntry(s(), states, { id: "1", name: "Kansas" });
      await addEntry(s(), states, { id: "2", name: "Iowa" });
      await addEntry(s(), states, { id: "3", name: "Nowhere" });
      await addEntry(s(), deployments, { id: "d1", name: "Main Street", stateId: "1" });
      await addEntry(s(), deployments, { id: "d2", name: "Oak Ave", stateId: "1" });
      await addEntry(s(), deployments, { id: "d3", name: "Elm", stateId: "2" });
      await addEntry(s(), deployments, { id: "d4", name: "Lost", stateId: "99" });
      for (const [deploymentId, agencyId] of [
        ["d1", "a1"],
        ["d1", "a2"],
        ["d1", "a3"],
        ["d2", "a1"],
      ]) {
        await addEntry(s(), agencies, { deploymentId, agencyId });
      }
      await addEntry(s(), links, { stateName: " kansas ", type: "docs", url: "https://ks/docs" });
      await addEntry(s(), links, { stateName: "KANSAS", type: "benefits", url: "https://ks/ben" });
      await addEntry(s(), links, { stateName: "Kansas", type: "other", url: "https://ks/other" });
      await addEntry(s(), links, { stateName: "Iowa", type: "docs", url: "https://ia/docs" });
      await addEntry(s(), links, { stateName: "Atlantis", type: "docs", url: "https://x/docs" });
      await s().expectOk(
        `insert into public.geometries (dataset_id, entry_id, source, type, created_by)
         values (${sqlLit(states)}, ${sqlLit(kansas)}, '{"type": "Point", "coordinates": [1.0, 2.0]}'::jsonb, 'Point', ${sqlLit(ALICE)})`,
      );

      const metas: CompileInputMeta[] = [
        {
          alias: "states",
          datasetId: states,
          title: "States",
          fields: [
            { name: "id", type: "string" },
            { name: "name", type: "string" },
          ],
        },
        {
          alias: "deployments",
          datasetId: deployments,
          title: "Deployments",
          fields: [
            { name: "id", type: "string" },
            { name: "name", type: "string" },
            { name: "stateId", type: "string" },
          ],
        },
        {
          alias: "deploymentAgencies",
          datasetId: agencies,
          title: "Deployment agencies",
          fields: [
            { name: "deploymentId", type: "string" },
            { name: "agencyId", type: "string" },
          ],
        },
        {
          alias: "links",
          datasetId: links,
          title: "Links",
          fields: [
            { name: "stateName", type: "string" },
            { name: "type", type: "string" },
            { name: "url", type: "string" },
          ],
        },
      ];
      const none = { trim: false, caseFold: false, collapseSpace: false, stripDiacritics: false };
      const def: ViewDefinition = {
        inputs: metas.map((meta) => ({
          alias: meta.alias,
          ref: { kind: "dataset" as const, id: meta.datasetId },
        })),
        base: "states",
        steps: [
          {
            kind: "join",
            right: {
              input: "deployments",
              steps: [
                {
                  kind: "join",
                  right: { input: "deploymentAgencies" },
                  on: [{ left: "id", right: "deploymentId" }],
                  matching: none,
                  type: "left",
                  multiMatch: {
                    mode: "summarize",
                    measures: [{ as: "agencyCount", fn: "count" }],
                  },
                },
              ],
            },
            on: [{ left: "id", right: "stateId" }],
            matching: none,
            type: "left",
            multiMatch: {
              mode: "summarize",
              measures: [
                { as: "deployments", fn: "count", emptyValue: 0 },
                {
                  as: "mostCollaboration",
                  fn: "topBy",
                  field: "name",
                  by: "agencyCount",
                  direction: "max",
                },
              ],
            },
          },
          {
            kind: "join",
            right: { input: "links" },
            on: [{ left: "name", right: "stateName" }],
            matching: { ...none, trim: true, caseFold: true },
            type: "left",
            multiMatch: {
              mode: "spread",
              by: "type",
              value: "url",
              columns: [
                { category: "docs", as: "docsLink" },
                { category: "benefits", as: "benefitsLink" },
              ],
            },
          },
        ],
        output: {
          fields: [
            { key: "name" },
            { key: "deployments", label: "Deployments" },
            { key: "mostCollaboration", label: "Most collaboration" },
            { key: "docsLink" },
            { key: "benefitsLink" },
          ],
          emptyFields: "omit",
        },
      };
      expect(validateViewDefinition(def, metas).ok).toBe(true);

      const rows = compileView(def, metas);
      const result = await s().expectOk(
        `select q.d as d, st_astext(q.geom) as wkt
         from (${bind(rows.sql, rows.params)}) q
         order by q.d->>'name'`,
      );
      const parsed = result.map((r) => ({ d: JSON.parse(r.d ?? "null"), wkt: r.wkt }));
      expect(parsed.map((r) => r.d)).toEqual([
        {
          name: "Iowa",
          deployments: 1,
          mostCollaboration: "Elm",
          docsLink: "https://ia/docs",
          benefitsLink: null,
        },
        {
          name: "Kansas",
          deployments: 2,
          mostCollaboration: "Main Street",
          docsLink: "https://ks/docs",
          benefitsLink: "https://ks/ben",
        },
        {
          name: "Nowhere",
          deployments: 0,
          mostCollaboration: null,
          docsLink: null,
          benefitsLink: null,
        },
      ]);
      // agencyCount is a sub-pipeline field only; it never reaches the view.
      for (const r of parsed) expect(Object.keys(r.d)).not.toContain("agencyCount");
      expect(parsed.map((r) => r.wkt)).toEqual([null, "POINT(1 2)", null]);

      const diag = compileDiagnostics(def, metas);
      const diagRows = await s().expectOk(bind(diag.sql, diag.params));
      const steps = JSON.parse(diagRows[0].diagnostics ?? "null").steps;
      // Execution order: the sub-pipeline join, the outer deployments join, the links join.
      expect(steps.map((step: { path?: string }) => step.path ?? null)).toEqual([
        "steps[0].right.steps[0]",
        null,
        null,
      ]);
      expect(steps[2]).toMatchObject({
        join: {
          leftUnmatched: 1,
          leftUnmatchedSamples: ["Nowhere"],
          rightUnmatched: 1,
          rightUnmatchedSamples: ["Atlantis"],
          spread: { undeclaredCategories: ["other"] },
        },
      });
    } finally {
      await dropDatasets(s(), [states, deployments, agencies, links]);
    }
  });

  test("calculate and sql steps, and the error multi-match guard", async () => {
    const states = await createDataset(s(), { createdBy: ALICE, properties: ["id", "cost"] });
    const items = await createDataset(s(), { createdBy: ALICE, properties: ["k", "label"] });
    try {
      await addEntry(s(), states, { id: "1", cost: 10, name: "Kansas" });
      await addEntry(s(), states, { id: "2", cost: 4, name: "Iowa" });
      await addEntry(s(), items, { k: "1", label: "a" });
      await addEntry(s(), items, { k: "1", label: "b" });
      await addEntry(s(), items, { k: "2", label: "c" });

      const metas: CompileInputMeta[] = [
        {
          alias: "states",
          datasetId: states,
          title: "States",
          fields: [
            { name: "id", type: "string" },
            { name: "name", type: "string" },
            { name: "cost", type: "number" },
          ],
        },
        { alias: "items", datasetId: items, title: "Items" },
      ];
      const inputs = metas.map((meta) => ({
        alias: meta.alias,
        ref: { kind: "dataset" as const, id: meta.datasetId },
      }));
      const none = { trim: false, caseFold: false, collapseSpace: false, stripDiacritics: false };
      const view = (steps: ViewDefinition["steps"]): ViewDefinition => ({
        inputs,
        base: "states",
        steps,
        output: { fields: [], emptyFields: "keep" },
      });

      const calc = compileView(
        view([
          { kind: "calculate", field: "band", expr: "if(cost > 5, upper(name), lower(name))" },
          { kind: "calculate", field: "double", expr: "round(cost * 2.5, 1)" },
          {
            kind: "sql",
            query:
              "select p.row_id, p.d || jsonb_build_object('items', (select count(*) from in_items)) as d from prev p",
          },
        ]),
        metas,
      );
      const calcRows = await s().expectOk(
        `select q.d as d from (${bind(calc.sql, calc.params)}) q order by q.d->>'name'`,
      );
      expect(calcRows.map((r) => JSON.parse(r.d ?? "null"))).toEqual([
        { id: "2", cost: 4, name: "Iowa", band: "iowa", double: 10, items: 3 },
        { id: "1", cost: 10, name: "Kansas", band: "KANSAS", double: 25, items: 3 },
      ]);

      const guarded = compileView(
        view([
          {
            kind: "join",
            right: { input: "items" },
            on: [{ left: "id", right: "k" }],
            matching: none,
            type: "left",
            multiMatch: { mode: "error" },
          },
        ]),
        metas,
      );
      const failure = await s().query(`select * from (${bind(guarded.sql, guarded.params)}) q`);
      expect(failure.error).toContain("Multiple rows match the join key: 1");
    } finally {
      await dropDatasets(s(), [states, items]);
    }
  });
});

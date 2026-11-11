// Integration test — Views reuse (#307) against the local Supabase Postgres:
// Duplicate + remap of a view onto a different states-like dataset runs (the
// definition is rewritten by `remapInputs`, checked by the real validator
// against the new dataset's declared fields, compiled and EXECUTED), and an
// Extract to view rewrite returns the same rows once the extracted view's
// rows are saved. Same wire-client pattern as pg-views-advanced.int.test.ts.
// Skips with a one-line message when the stack is unreachable.

import {
  applyExtract,
  compileView,
  planExtract,
  remapInputs,
  remapReport,
} from "@caden/data-core/views";
import type { CompileInputMeta, ViewDefinition } from "@caden/data-core/views";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
  createDataset,
  DB_URL,
  dbUp,
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

function bind(sql: string, params: unknown[]): string {
  return sql.replaceAll(/\$(\d+)(?=::)/g, (_match, n: string) => sqlLit(params[Number(n) - 1]));
}

async function names(meta: CompileInputMeta[], def: ViewDefinition) {
  const compiled = compileView(def, meta);
  const result = await s().expectOk(
    `select q.d as d from (${bind(compiled.sql, compiled.params)}) q order by q.d->>'name'`,
  );
  return result.map((r) => JSON.parse(r.d ?? "null") as Record<string, unknown>);
}

const none = { trim: false, caseFold: false, collapseSpace: false, stripDiacritics: false };

describe.skipIf(!dbUp())("views reuse against Postgres", () => {
  test("duplicate + remap onto a different states-like dataset validates and runs", async () => {
    const states = await createDataset(s(), { createdBy: ALICE, properties: ["id", "name"] });
    const provinces = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["id", "name", "region"],
    });
    const deployments = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["id", "stateId"],
    });
    await addEntry(s(), states, { id: "1", name: "Kansas" });
    await addEntry(s(), provinces, { id: "1", name: "Ontario", region: "East" });
    await addEntry(s(), provinces, { id: "2", name: "Alberta", region: "West" });
    await addEntry(s(), deployments, { id: "d1", stateId: "1" });
    await addEntry(s(), deployments, { id: "d2", stateId: "1" });
    await addEntry(s(), deployments, { id: "d3", stateId: "2" });

    const original: ViewDefinition = {
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
          matching: none,
          type: "left",
          multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count", emptyValue: 0 }] },
        },
      ],
      output: { fields: [{ key: "name", label: "Name" }, { key: "n" }], emptyFields: "keep" },
    };
    const copy = remapInputs(original, [
      { alias: "states", datasetId: provinces, oldTitle: "States" },
    ]);
    const metas: CompileInputMeta[] = [
      {
        alias: "states",
        datasetId: provinces,
        title: "Provinces",
        fields: [{ name: "id" }, { name: "name" }, { name: "region" }],
      },
      {
        alias: "deployments",
        datasetId: deployments,
        title: "Deployments",
        fields: [{ name: "id" }, { name: "stateId" }],
      },
    ];
    const report = remapReport(copy, metas);
    expect(report.ok).toBe(true);
    expect(await names(metas, copy)).toEqual([
      { name: "Alberta", n: 1 },
      { name: "Ontario", n: 2 },
    ]);
    // The labels were copied with the definition.
    expect(copy.output.fields[0]).toEqual({ key: "name", label: "Name" });
  });

  test("extract to view: the rewritten definition returns the same rows", async () => {
    const states = await createDataset(s(), { createdBy: ALICE, properties: ["id", "name"] });
    const deployments = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["id", "stateId", "cost"],
    });
    const extracted = await createDataset(s(), { createdBy: ALICE, properties: ["id", "stateId"] });
    await addEntry(s(), states, { id: "1", name: "Kansas" });
    await addEntry(s(), states, { id: "2", name: "Iowa" });
    await addEntry(s(), deployments, { id: "d1", stateId: "1", cost: 5 });
    await addEntry(s(), deployments, { id: "d2", stateId: "1", cost: 50 });
    await addEntry(s(), deployments, { id: "d3", stateId: "2", cost: 70 });

    const def: ViewDefinition = {
      inputs: [
        { alias: "states", ref: { kind: "dataset", id: states } },
        { alias: "deployments", ref: { kind: "dataset", id: deployments } },
      ],
      base: "states",
      steps: [
        {
          kind: "join",
          right: {
            input: "deployments",
            steps: [{ kind: "filter", where: { field: "cost", op: "gt", value: 10 } }],
          },
          on: [{ left: "id", right: "stateId" }],
          matching: none,
          type: "left",
          multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count", emptyValue: 0 }] },
        },
      ],
      output: { fields: [], emptyFields: "keep" },
    };
    const metas: CompileInputMeta[] = [
      {
        alias: "states",
        datasetId: states,
        title: "States",
        fields: [{ name: "id" }, { name: "name" }],
      },
      {
        alias: "deployments",
        datasetId: deployments,
        title: "Deployments",
        fields: [{ name: "id" }, { name: "stateId" }, { name: "cost" }],
      },
    ];
    const inline = await names(metas, def);

    const planned = planExtract(def, [0], "Deployments");
    if (!planned.ok) throw new Error(planned.reason);
    // "Run" the extracted view: save its rows as the new dataset's entries.
    const compiled = compileView(planned.plan.view, metas);
    const rows = await s().expectOk(
      `select q.d as d from (${bind(compiled.sql, compiled.params)}) q`,
    );
    for (const row of rows) {
      await addEntry(s(), extracted, JSON.parse(row.d ?? "{}") as Record<string, unknown>);
    }
    const edited = applyExtract(def, [0], planned.plan, {
      id: extracted,
      title: "Big deployments",
    });
    const editedMetas: CompileInputMeta[] = [
      ...metas.filter((meta) => meta.alias === "states"),
      {
        alias: "big_deployments",
        datasetId: extracted,
        title: "Big deployments",
        fields: [{ name: "id" }, { name: "stateId" }, { name: "cost" }],
      },
    ];
    expect(await names(editedMetas, edited)).toEqual(inline);
    expect(inline).toEqual([
      { id: "2", name: "Iowa", n: 1 },
      { id: "1", name: "Kansas", n: 1 },
    ]);
  });
});

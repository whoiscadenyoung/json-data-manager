// Integration tests — the server-side Scratch query (#306; docs/views-design.md
// §9). Like pg-views.int.test.ts the runner opens its OWN connections, so
// fixtures are COMMITTED (autocommit admin session) and removed in afterEach.
// Needs a DEDICATED CI-parity db (docs/memory/int-test-db-split-ri-teardown.md).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ViewCompiler, ViewDefinition } from "#/lib/views/view-compiler";
import { defaultViewCompiler, inputsOfDefinition } from "#/lib/views/view-compiler-wiring";
import { createView, type ViewDeps, type ViewsRpc } from "#/lib/views/view-save";
import type { VerifiedClaims } from "#/server/views/claims";
import { connect } from "#/server/views/entry.server";
import { runViewAs, type RunnerDeps } from "#/server/views/runner";
import { scratchAs, type ScratchTable } from "#/server/views/scratch";

import {
  addEntry,
  ALICE,
  BOB,
  CAROL,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  ensureUsers,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

let session: PgSession | undefined;
const runnerSql = dbUp() ? connect(DB_URL, 4) : undefined;
const created = { projects: [] as string[], views: [] as string[], sources: [] as string[] };

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

afterEach(async () => {
  if (session === undefined) return;
  await session.rollbackIfOpen();
  await session.asAdmin();
  for (const id of created.projects) {
    await session.expectOk(`delete from public.projects where id = ${sqlLit(id)}`);
  }
  for (const id of created.views.toReversed()) {
    await session.expectOk(`delete from public.datasets where id = ${sqlLit(id)}`);
  }
  await dropDatasets(session, created.sources);
  created.projects = [];
  created.views = [];
  created.sources = [];
});

afterAll(async () => {
  if (session) {
    await session.rollbackIfOpen();
    await session.close();
  }
  session = undefined;
  if (runnerSql) await runnerSql.end({ timeout: 2 });
});

function who(userId: string): VerifiedClaims {
  return { sub: userId, role: "authenticated", claims: { sub: userId, role: "authenticated" } };
}

function deps(compiler: ViewCompiler = defaultViewCompiler, timeoutMs = 30_000): RunnerDeps {
  if (runnerSql === undefined) throw new Error("no db");
  return { sql: runnerSql, compiler, timeoutMs };
}

/** A project (ALICE owner, BOB editor) holding two published datasets: states and deployments. */
async function fixture() {
  await s().asAdmin();
  const states = await createDataset(s(), {
    createdBy: ALICE,
    lifecycle: "published",
    properties: ["id", "name"],
    visibility: "signed-in",
  });
  const deployments = await createDataset(s(), {
    createdBy: ALICE,
    lifecycle: "published",
    properties: ["stateId", "cost"],
    visibility: "signed-in",
  });
  created.sources.push(states, deployments);
  await s().expectOk(`update public.datasets set title = 'States' where id = ${sqlLit(states)}`);
  await s().expectOk(
    `update public.datasets set title = 'Deployments' where id = ${sqlLit(deployments)}`,
  );
  await addEntry(s(), states, { id: "s1", name: "Alpha" });
  await addEntry(s(), states, { id: "s2", name: "Beta" });
  await addEntry(s(), deployments, { stateId: "s1", cost: 10 });
  await addEntry(s(), deployments, { stateId: "s1", cost: 5 });
  await addEntry(s(), deployments, { stateId: "s2", cost: 7 });
  const project = crypto.randomUUID();
  created.projects.push(project);
  // The projects/project_artifacts stamp triggers take the owner from the
  // request identity, so the project is created as ALICE inside a transaction.
  await s().begin();
  await s().asUser(ALICE);
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(project)}, 'scratch', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(project)}, ${sqlLit(BOB)}, 'editor')`,
  );
  for (const id of [states, deployments]) {
    await s().expectOk(
      `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
       values (${sqlLit(project)}, ${sqlLit(id)}, 'dataset', 'owned', 'manual')`,
    );
  }
  await s().commit();
  await s().asAdmin();
  return { project, states, deployments };
}

const JOIN_SQL = `select s.d->>'name' as name, sum((x.d->>'cost')::numeric) as total
from in_states s join in_deployments x on x.d->>'stateId' = s.d->>'id'
group by 1 order by 1`;

function outcomeOf(result: Awaited<ReturnType<typeof scratchAs>>) {
  if (result.outcome === undefined) throw new Error("no outcome");
  return result.outcome;
}

describe.skipIf(!dbUp())("scratch query (#306)", () => {
  test("lists the project's tables with stable names, and joins two datasets", async () => {
    const { project, states } = await fixture();
    const result = await scratchAs(deps(), who(ALICE), project, JOIN_SQL);
    expect(result.tables.map((t) => t.name)).toStrictEqual(["in_deployments", "in_states"]);
    expect(result.tables.find((t) => t.datasetId === states)).toMatchObject({
      alias: "states",
      fields: ["id", "name"],
      kind: "source",
      title: "States",
    });
    const outcome = outcomeOf(result);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.columns).toStrictEqual(["name", "total"]);
    expect(outcome.rows).toStrictEqual([
      { name: "Alpha", total: 15 },
      { name: "Beta", total: 7 },
    ]);
    expect(outcome.truncated).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("the row cap truncates and says so", async () => {
    const { project } = await fixture();
    const result = await scratchAs(deps(), who(ALICE), project, "select * from in_deployments", {
      maxRows: 2,
    });
    const outcome = outcomeOf(result);
    expect(outcome.ok && outcome.rowCount).toBe(2);
    expect(outcome.ok && outcome.truncated).toBe(true);
  });

  test("a user who cannot read the project or its datasets gets no tables and an error", async () => {
    const { project, states } = await fixture();
    // Make the datasets private to ALICE's project: CAROL is not a member.
    await s().expectOk(
      `update public.datasets set visibility = 'members', lifecycle = 'draft' where id = any(array[${created.sources.map((id) => sqlLit(id)).join(",")}]::uuid[])`,
    );
    const result = await scratchAs(deps(), who(CAROL), project, "select * from in_states");
    expect(result.tables).toStrictEqual([]);
    const outcome = outcomeOf(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toMatch(/in_states/);
    // ALICE still reads it.
    const alice = await scratchAs(deps(), who(ALICE), project, "select * from in_states");
    expect(alice.tables.some((t) => t.datasetId === states)).toBe(true);
  });

  test("a slow query hits the timeout with a clear message", async () => {
    const { project } = await fixture();
    const result = await scratchAs(
      deps(defaultViewCompiler, 300),
      who(ALICE),
      project,
      "select count(*) from generate_series(1, 2000000000)",
    );
    const outcome = outcomeOf(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toMatch(/cancelled \(timeout\)/);
  });

  test("DML is refused, however it is written, and no data changes", async () => {
    const { project, states } = await fixture();
    const attempts = [
      "delete from public.entries",
      `with gone as (delete from public.entries where dataset_id = ${sqlLit(states)} returning 1) select * from gone`,
      "select 1; delete from public.entries",
      "select set_config('request.jwt.claims', '{}', true)",
    ];
    for (const sql of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: each attempt must leave the data alone.
      const outcome = outcomeOf(await scratchAs(deps(), who(ALICE), project, sql));
      expect(outcome.ok).toBe(false);
    }
    const left = await s().expectOk(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(states)}`,
    );
    expect(left).toStrictEqual([{ n: "2" }]);
  });

  test("Save as view: the saved sql step returns the same rows as the scratch run", async () => {
    const { project } = await fixture();
    const scratch = await scratchAs(deps(), who(ALICE), project, JOIN_SQL);
    const tables: ScratchTable[] = scratch.tables;
    // What the UI's "Save as view" builds (definitionFromScratch, unit-tested in
    // features/views): one sql step, the query unchanged, inputs aliased by table.
    const definition: ViewDefinition = {
      inputs: tables.map((table) => ({
        alias: table.alias,
        ref: { kind: "dataset", id: table.datasetId },
      })),
      base: "states",
      steps: [{ kind: "sql", query: JOIN_SQL }],
      output: { fields: [], emptyFields: "keep" },
    };

    const rpc: ViewsRpc = {
      call: async (fn, args) => {
        const named = Object.entries(args)
          .map(([key, value]) =>
            value !== null && typeof value === "object"
              ? `${key} => ${sqlLit(JSON.stringify(value))}::jsonb`
              : `${key} => ${sqlLit(value)}`,
          )
          .join(", ");
        await s().begin();
        await s().asUser(ALICE);
        const result = await s().query(`select public.${fn}(${named}) as r`);
        if (result.error !== undefined) {
          await s().rollback();
          throw new Error(result.error);
        }
        await s().commit();
        const first = result.rows[0];
        return first === undefined ? null : first.r;
      },
    };
    const viewDeps: ViewDeps = { rpc, compiler: defaultViewCompiler };
    const view = await createView(viewDeps, {
      title: "Cost per state",
      definition,
      inputs: inputsOfDefinition(definition),
      lifecycle: "draft",
      visibility: "members",
    });
    created.views.push(view);

    const outcome = await runViewAs(deps(), who(ALICE), view);
    expect(outcome.status).toBe("ok");
    const rows = await s().expectOk(
      `select data->>'name' as name, (data->>'total')::numeric::float8 as total
       from public.entries where dataset_id = ${sqlLit(view)} order by 1`,
    );
    const scratched = outcomeOf(scratch);
    expect(rows.map((row) => ({ name: row.name, total: Number(row.total) }))).toStrictEqual(
      scratched.ok ? scratched.rows.map((row) => ({ name: row["name"], total: row["total"] })) : [],
    );
  });
});

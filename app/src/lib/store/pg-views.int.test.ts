// Integration tests — Views schema, the SERVER-SIDE runner, previews and
// staleness (issue #300; migration 0027_views.sql; docs/views-design.md §7).
//
// The runner under test is the real one (`#/server/views/runner`): it opens
// its OWN Postgres connections (postgres.js), so — unlike the other
// pg-*.int.test.ts files — fixtures are COMMITTED (autocommit as the admin
// session) and removed again in afterEach. User-side actions (create_view,
// save_view, direct writes, denied calls) run on the wire session inside a
// short transaction as that user. The compiler is a tiny FAKE for the
// database-contract tests plus the REAL @caden/data-core/views compiler for
// one end-to-end test.
// Needs a DEDICATED CI-parity db (docs/memory/int-test-db-split-ri-teardown.md).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CompileInputMeta, ViewCompiler, ViewDefinition } from "#/lib/views/view-compiler";
import { defaultViewCompiler, inputsOfDefinition } from "#/lib/views/view-compiler-wiring";
import { createView, saveView, type ViewDeps, type ViewsRpc } from "#/lib/views/view-save";
import type { VerifiedClaims } from "#/server/views/claims";
import { connect } from "#/server/views/entry.server";
import { previewAs, runReadOnlyAsUser, runViewAs, type RunnerDeps } from "#/server/views/runner";

import {
  ALICE,
  BOB,
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
const created: { views: string[]; sources: string[] } = { views: [], sources: [] };
const LEAST_PRIVILEGE_ROLE = "jdm_server_int";

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
  // Newest first: a chained view reads an older one (NO ACTION input FK).
  for (const id of [...created.views].reverse()) {
    await session.expectOk(`delete from public.datasets where id = ${sqlLit(id)}`);
  }
  await dropDatasets(session, created.sources);
  created.views = [];
  created.sources = [];
});

afterAll(async () => {
  if (session) {
    await session.rollbackIfOpen();
    await session.expectOk(`drop role if exists ${LEAST_PRIVILEGE_ROLE}`);
    await session.close();
  }
  session = undefined;
  if (runnerSql) await runnerSql.end({ timeout: 2 });
});

// ---------------------------------------------------------------------------
// The fake compiler
// ---------------------------------------------------------------------------

/** Definition shape of the fake: design §4's `inputs`, plus `fail` / `sleep` switches. */
function definitionOver(datasetIds: string[], extra: Record<string, unknown> = {}) {
  return {
    inputs: datasetIds.map((id, i) => ({ alias: `in${i}`, ref: { kind: "dataset", id } })),
    ...extra,
  };
}

function firstId(inputs: CompileInputMeta[]): string {
  const first = inputs[0];
  if (first === undefined) throw new Error("no inputs");
  return first.datasetId;
}

const fakeCompiler: ViewCompiler = {
  validateViewDefinition: (definition) =>
    typeof definition === "object" && definition !== null
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake compiler accepts any object as a "definition"; only the real compiler (below) sees real ViewDefinitions.
        { ok: true, value: definition as ViewDefinition }
      : { ok: false, errors: [{ path: "", message: "not an object" }] },
  compileView: (definition, inputs, options) => {
    if ("fail" in definition) {
      return {
        sql: "select 1 / 0 as row_id, '{}'::jsonb as d, null::geometry as geom",
        params: [],
      };
    }
    if ("sleep" in definition) {
      return {
        sql: "select (pg_sleep(5))::text::uuid as row_id, '{}'::jsonb as d, null::geometry as geom",
        params: [],
      };
    }
    const limit =
      options === undefined || options.limit === undefined ? "" : ` limit ${options.limit}`;
    return {
      sql:
        "select e.id as row_id, e.data as d, g.geom from public.entries e " +
        "left join public.geometries g on g.entry_id = e.id where e.dataset_id = $1::uuid" +
        ` order by e.created_at, e.id${limit}`,
      params: [firstId(inputs)],
    };
  },
  compileDiagnostics: (_definition, inputs) => ({
    sql: "select jsonb_build_object('rowsIn', count(*)) as diagnostics from public.entries where dataset_id = $1::uuid",
    params: [firstId(inputs)],
  }),
  viewInputDatasetIds: (_definition, inputs) => inputs.map((i) => i.datasetId),
};

// ---------------------------------------------------------------------------
// Transports and fixtures
// ---------------------------------------------------------------------------

function who(userId: string): VerifiedClaims {
  return { sub: userId, role: "authenticated", claims: { sub: userId, role: "authenticated" } };
}

function runnerDeps(
  opts: { compiler?: ViewCompiler; timeoutMs?: number; url?: string } = {},
): RunnerDeps {
  if (runnerSql === undefined) throw new Error("no db");
  return {
    sql: opts.url === undefined ? runnerSql : connect(opts.url, 2),
    compiler: opts.compiler ?? fakeCompiler,
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
}

function litOf(value: unknown): string {
  if (value !== null && typeof value === "object") return `${sqlLit(value)}::jsonb`;
  return sqlLit(value);
}

/** The save-path RPCs, issued as `userId` in one short COMMITTED transaction each. */
function savePath(userId: string, compiler: ViewCompiler = fakeCompiler): ViewDeps {
  const rpc: ViewsRpc = {
    call: async (fn, args) => {
      const named = Object.entries(args)
        .map(([key, value]) => `${key} => ${litOf(value)}`)
        .join(", ");
      await s().begin();
      await s().asUser(userId);
      const result = await s().query(`select public.${fn}(${named}) as r`);
      if (result.error !== undefined) {
        await s().rollback();
        throw new Error(result.error);
      }
      await s().commit();
      const row = result.rows[0];
      const raw = row === undefined ? null : row.r;
      return raw === null || raw === undefined ? null : parseMaybeJson(raw);
    },
  };
  return { rpc, compiler };
}

function parseMaybeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function source(opts: {
  lifecycle?: "draft" | "published";
  rows: number;
  geometry?: boolean;
}) {
  await s().asAdmin();
  const id = await createDataset(s(), {
    createdBy: ALICE,
    lifecycle: opts.lifecycle ?? "published",
    visibility: opts.lifecycle === "draft" ? "members" : "signed-in",
  });
  created.sources.push(id);
  await s().expectOk(
    `insert into public.entries (dataset_id, data)
     select ${sqlLit(id)}, jsonb_build_object('name', 'row ' || g) from generate_series(1, ${opts.rows}) g`,
  );
  if (opts.geometry === true) {
    await s().expectOk(
      `insert into public.geometries (dataset_id, entry_id, source, type)
       select dataset_id, id, '{"type":"Point","coordinates":[1,2]}'::jsonb, 'Point'
       from public.entries where dataset_id = ${sqlLit(id)}`,
    );
  }
  return id;
}

async function newView(
  inputIds: string[],
  extra: { editPolicy?: "open" | "locked"; flags?: Record<string, unknown>; by?: string } = {},
): Promise<string> {
  const definition = definitionOver(inputIds, extra.flags ?? {});
  const id = await createView(savePath(extra.by ?? ALICE), {
    title: "fixture view",
    definition,
    inputs: inputsOfDefinition(definition),
    lifecycle: "published",
    visibility: "signed-in",
    editPolicy: extra.editPolicy ?? "open",
  });
  created.views.push(id);
  return id;
}

async function one(sql: string): Promise<Record<string, string | null>> {
  const rows = await s().expectOk(sql);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${sql}`);
  return row;
}

/** Read as `userId` in a rolled-back transaction. */
async function asUserRead(userId: string, sql: string): Promise<Record<string, string | null>[]> {
  await s().begin();
  await s().asUser(userId);
  try {
    return await s().expectOk(sql);
  } finally {
    await s().rollback();
  }
}

async function stale(viewId: string): Promise<boolean> {
  const rows = await asUserRead(
    ALICE,
    `select public.view_stale(d) as v from public.datasets d where d.id = ${sqlLit(viewId)}`,
  );
  const first = rows[0];
  return first !== undefined && first.v === "t";
}

/** A statement expected to RAISE as `userId`; returns the message. */
async function raisesAs(userId: string, text: string): Promise<string> {
  await s().begin();
  await s().asUser(userId);
  const result = await s().query(text);
  await s().rollback();
  if (result.error !== undefined) return result.error;
  throw new Error(`expected the statement to raise: ${text}`);
}

describe.skipIf(!dbUp())("views (#300)", () => {
  test("a run writes rows and geometries and bumps the tile cache version", async () => {
    const input = await source({ rows: 5, geometry: true });
    const view = await newView([input]);
    const before = await one(
      `select map_tile_cache_version::int as v from public.datasets where id = ${sqlLit(view)}`,
    );

    const outcome = await runViewAs(runnerDeps(), who(ALICE), view);
    expect(outcome.status).toBe("ok");

    const after = await one(
      `select entry_count, feature_count, is_geospatial, geometry_type,
              map_tile_cache_version::int as v, data_version::int as dv, properties::text as p
       from public.datasets where id = ${sqlLit(view)}`,
    );
    expect(after.entry_count).toBe("5");
    expect(after.feature_count).toBe("5");
    expect(after.is_geospatial).toBe("t");
    expect(after.geometry_type).toBe("Point");
    expect(Number(after.v)).toBeGreaterThan(Number(before.v));
    expect(Number(after.dv)).toBeGreaterThan(0);
    expect(after.p).toBe('["name"]');
    const geom = await one(
      `select count(*) as n from public.geometries where dataset_id = ${sqlLit(view)} and geom is not null and bbox is not null`,
    );
    expect(geom.n).toBe("5");
    const run = await one(
      `select status, row_count, input_versions::text as iv from public.view_runs where view_id = ${sqlLit(view)}`,
    );
    expect(run.status).toBe("ok");
    expect(run.row_count).toBe("5");
    expect(run.iv).toContain(input);

    // An unchanged re-run diffs to nothing: no churn, no tile bump.
    const second = await runViewAs(runnerDeps(), who(ALICE), view);
    expect(second.status).toBe("ok");
    const again = await one(
      `select map_tile_cache_version::int as v from public.datasets where id = ${sqlLit(view)}`,
    );
    expect(again.v).toBe(after.v);
  });

  test("stale flips after an input edit", async () => {
    const input = await source({ rows: 3 });
    const view = await newView([input]);
    expect(await stale(view)).toBe(true); // never run

    await runViewAs(runnerDeps(), who(ALICE), view);
    expect(await stale(view)).toBe(false);

    await s().expectOk(
      `insert into public.entries (dataset_id, data) values (${sqlLit(input)}, '{"name":"late"}')`,
    );
    expect(await stale(view)).toBe(true);

    expect((await runViewAs(runnerDeps(), who(ALICE), view)).status).toBe("ok");
    expect(await stale(view)).toBe(false);
    const rows = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(rows.n).toBe("4");
  });

  test("the catalog summary select reads the stale flag as a field", async () => {
    const input = await source({ rows: 1 });
    const view = await newView([input]);
    const [row] = await asUserRead(
      ALICE,
      `select kind, refresh_mode, public.view_stale(d) as stale from public.datasets d where id = ${sqlLit(view)}`,
    );
    expect(row).toMatchObject({ kind: "view", refresh_mode: "manual", stale: "t" });
    const [src] = await asUserRead(
      ALICE,
      `select public.view_stale(d) as stale from public.datasets d where id = ${sqlLit(input)}`,
    );
    expect(src).toMatchObject({ stale: "f" });
  });

  test("a viewer cannot run (and nothing is recorded)", async () => {
    const input = await source({ rows: 2 });
    const view = await newView([input], { editPolicy: "locked" });
    await expect(runViewAs(runnerDeps(), who(BOB), view)).rejects.toThrow(/not writable/);
    const runs = await one(
      `select count(*) as n from public.view_runs where view_id = ${sqlLit(view)}`,
    );
    expect(runs.n).toBe("0");
    // ...and Bob cannot read the run history even of a run Alice makes.
    await runViewAs(runnerDeps(), who(ALICE), view);
    const visible = await asUserRead(
      BOB,
      `select count(*) as n from public.view_runs where view_id = ${sqlLit(view)}`,
    );
    expect(visible[0]).toMatchObject({ n: "0" });
  });

  test("the runner enforces RLS: an editor who cannot see an input is refused", async () => {
    const draft = await source({ lifecycle: "draft", rows: 2 });
    const view = await newView([draft]); // Alice's open view over her members-only draft
    // Bob may edit the open view but cannot view its draft input.
    await expect(runViewAs(runnerDeps(), who(BOB), view)).rejects.toThrow(/not visible/);
    await expect(previewAs(runnerDeps(), who(BOB), { viewId: view })).rejects.toThrow(
      /not visible/,
    );
    const runs = await one(
      `select count(*) as n from public.view_runs where view_id = ${sqlLit(view)}`,
    );
    expect(runs.n).toBe("0");
  });

  test("a failed run keeps the previous rows and records the error", async () => {
    const input = await source({ rows: 4 });
    const view = await newView([input]);
    expect((await runViewAs(runnerDeps(), who(ALICE), view)).status).toBe("ok");

    const broken = definitionOver([input], { fail: true });
    await saveView(savePath(ALICE), view, {
      definition: broken,
      inputs: inputsOfDefinition(broken),
    });
    const outcome = await runViewAs(runnerDeps(), who(ALICE), view);
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).toMatch(/division by zero/);

    const rows = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(rows.n).toBe("4");
    const last = await one(
      `select status, error from public.view_runs where view_id = ${sqlLit(view)} order by finished_at desc, id limit 1`,
    );
    expect(last.status).toBe("error");
    expect(last.error).toMatch(/division by zero/);
    expect(await stale(view)).toBe(true); // definition changed since the last good run
  });

  test("a statement timeout fires on the phase-1 read and the run errors out", async () => {
    const input = await source({ rows: 1 });
    const view = await newView([input], { flags: { sleep: true } });
    const started = Date.now();
    const outcome = await runViewAs(runnerDeps({ timeoutMs: 300 }), who(ALICE), view);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).toMatch(/timeout/);
  });

  test("a cycle is rejected", async () => {
    const input = await source({ rows: 1 });
    const a = await newView([input]);
    await newView([a]); // b reads a: fine
    const b = created.views[1] ?? "";
    const cyclic = definitionOver([b]);
    await expect(
      saveView(savePath(ALICE), a, { definition: cyclic, inputs: inputsOfDefinition(cyclic) }),
    ).rejects.toThrow(/cycle/);
    const self = definitionOver([a]);
    await expect(
      saveView(savePath(ALICE), a, { definition: self, inputs: inputsOfDefinition(self) }),
    ).rejects.toThrow(/cycle/);
    const inputs = await one(
      `select input_dataset_id::text as i from public.view_inputs where view_id = ${sqlLit(a)}`,
    );
    expect(inputs.i).toBe(input);
  });

  test("preview returns at most 50 rows plus full-input diagnostics (saved and draft)", async () => {
    const input = await source({ rows: 120 });
    const view = await newView([input]);
    const saved = await previewAs(runnerDeps(), who(ALICE), { viewId: view });
    expect(saved.rows).toHaveLength(50);
    expect(saved.diagnostics).toEqual({ rowsIn: 120 });

    // A draft (unsaved) DEFINITION previews too — JSON in, never SQL.
    const draft = definitionOver([input]);
    const preview = await previewAs(runnerDeps(), who(ALICE), {
      definition: draft,
      inputs: inputsOfDefinition(draft),
    });
    expect(preview.rows).toHaveLength(50);
    expect(preview.diagnostics).toEqual({ rowsIn: 120 });
  });

  test("a view over an UNPUBLISHED draft input works; an invisible input is refused on save", async () => {
    const draft = await source({ lifecycle: "draft", rows: 3 });
    const view = await newView([draft]);
    const outcome = await runViewAs(runnerDeps(), who(ALICE), view);
    expect(outcome.status).toBe("ok");

    const definition = definitionOver([draft]);
    await expect(
      createView(savePath(BOB), {
        title: "nope",
        definition,
        inputs: inputsOfDefinition(definition),
      }),
    ).rejects.toThrow(/not visible/);
  });

  test("a view's rows are written only by its run", async () => {
    const input = await source({ rows: 2 });
    const view = await newView([input]);
    await runViewAs(runnerDeps(), who(ALICE), view);

    const writes = [
      `insert into public.entries (dataset_id, data) values (${sqlLit(view)}, '{}')`,
      `update public.entries set data = '{}' where dataset_id = ${sqlLit(view)}`,
      `delete from public.entries where dataset_id = ${sqlLit(view)}`,
      `select public.import_entries(${sqlLit(view)}, '[{"data":{"a":1}}]'::jsonb)`,
    ];
    for (const write of writes) {
      expect(await raisesAs(ALICE, write)).toMatch(/is a view/);
    }
    // Admin writes too.
    await s().begin();
    const admin = await s().query(
      `insert into public.entries (dataset_id, data) values (${sqlLit(view)}, '{}')`,
    );
    await s().rollback();
    expect(admin.error).toMatch(/is a view/);

    // A client cannot mint a view directly.
    await raisesAs(
      ALICE,
      `insert into public.datasets (title, kind, definition, refresh_mode, created_by)
       values ('x', 'view', '{}', 'manual', ${sqlLit(ALICE)})`,
    );

    // Dropping the view itself cascades through the guard.
    await s().expectOk(`delete from public.datasets where id = ${sqlLit(view)}`);
    created.views = [];
    const left = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(left.n).toBe("0");
  });

  test("authenticated cannot execute any SQL-taking or row-taking function", async () => {
    const input = await source({ rows: 1 });
    const view = await newView([input]);
    // The SQL-taking RPC is gone entirely.
    expect(await raisesAs(ALICE, `select public.view_query('select 1')`)).toMatch(/does not exist/);
    const denied = [
      `select public.view_apply_run(${sqlLit(view)}, '[]'::jsonb, '{}'::jsonb)`,
      `select public.view_record_failure(${sqlLit(view)}, 'x')`,
      `select public.view_set_inputs(${sqlLit(view)}, '[]'::jsonb)`,
      `select public.view_assert_runnable(${sqlLit(view)})`,
      `select public.view_prune_runs(${sqlLit(view)})`,
    ];
    for (const call of denied) {
      expect(await raisesAs(ALICE, call)).toMatch(/permission denied/);
    }
  });

  test("the raw read-only entry: RLS-scoped, read-only, row-capped", async () => {
    const input = await source({ rows: 5 });
    const draft = await source({ lifecycle: "draft", rows: 2 });
    const deps = runnerDeps();
    const rows = await runReadOnlyAsUser(
      deps,
      who(ALICE),
      "select data->>'name' as name from public.entries where dataset_id = $1::uuid order by 1",
      [input],
      { maxRows: 10 },
    );
    expect(rows).toHaveLength(5);
    // RLS applies: Bob cannot read Alice's members-only draft.
    const hidden = await runReadOnlyAsUser(
      deps,
      who(BOB),
      "select count(*)::int as n from public.entries where dataset_id = $1::uuid",
      [draft],
    );
    expect(hidden).toEqual([{ n: 0 }]);
    // Writes and a stacked statement are refused; the row cap fires.
    await expect(
      runReadOnlyAsUser(
        deps,
        who(ALICE),
        "delete from public.entries where dataset_id = $1::uuid returning 1",
        [input],
      ),
    ).rejects.toThrow(/read-only|syntax error/);
    await expect(runReadOnlyAsUser(deps, who(ALICE), "select 1; select 2", [])).rejects.toThrow(
      /syntax error|cannot insert multiple commands/,
    );
    await expect(
      runReadOnlyAsUser(deps, who(ALICE), "select generate_series(1, 20) as n", [], { maxRows: 3 }),
    ).rejects.toThrow(/exceeds 3 rows/);
    const still = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(input)}`,
    );
    expect(still.n).toBe("5");
  });

  test("the least-privilege server role (view_runner member) runs a view", async () => {
    await s().expectOk(`drop role if exists ${LEAST_PRIVILEGE_ROLE}`);
    await s().expectOk(
      `create role ${LEAST_PRIVILEGE_ROLE} login password 'x' in role view_runner`,
    );
    const url = new URL(DB_URL);
    url.username = LEAST_PRIVILEGE_ROLE;
    url.password = "x";
    const input = await source({ rows: 3 });
    const view = await newView([input]);
    const deps = runnerDeps({ url: url.toString() });
    try {
      expect((await runViewAs(deps, who(ALICE), view)).status).toBe("ok");
      const rows = await one(
        `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
      );
      expect(rows.n).toBe("3");
      // It cannot do anything a plain login could not: no direct table writes.
      await expect(
        deps.sql.unsafe(`insert into public.entries (dataset_id, data) values ($1::uuid, '{}')`, [
          input,
        ]),
      ).rejects.toThrow(/permission denied|row-level security/);
    } finally {
      await deps.sql.end({ timeout: 2 });
    }
  });

  test("the REAL compiler runs end to end through the runner (join + summarize)", async () => {
    const states = await source({ rows: 0 });
    const deployments = await source({ rows: 0 });
    // The real validator checks field names against the declared properties.
    await s().expectOk(
      `update public.datasets set properties = '["id","name"]'::jsonb where id = ${sqlLit(states)}`,
    );
    await s().expectOk(
      `update public.datasets set properties = '["stateId","cost"]'::jsonb where id = ${sqlLit(deployments)}`,
    );
    await s().expectOk(
      `insert into public.entries (dataset_id, data) values
         (${sqlLit(states)}, '{"id":"s1","name":"Alpha"}'),
         (${sqlLit(states)}, '{"id":"s2","name":"Beta"}'),
         (${sqlLit(deployments)}, '{"stateId":"s1","cost":10}'),
         (${sqlLit(deployments)}, '{"stateId":"s1","cost":5}')`,
    );
    await s().expectOk(
      `insert into public.geometries (dataset_id, entry_id, source, type)
       select dataset_id, id, '{"type":"Point","coordinates":[1,2]}'::jsonb, 'Point'
       from public.entries where dataset_id = ${sqlLit(states)}`,
    );
    const definition = {
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
          matching: { trim: false, caseFold: false, collapseSpace: false, stripDiacritics: false },
          type: "left",
          multiMatch: {
            mode: "summarize",
            measures: [
              { as: "n", fn: "count" },
              { as: "total", fn: "sum", field: "cost" },
            ],
          },
        },
      ],
      output: { fields: [], emptyFields: "keep" },
    };
    const real = runnerDeps({ compiler: defaultViewCompiler });
    const preview = await previewAs(real, who(ALICE), {
      definition,
      inputs: inputsOfDefinition(definition),
    });
    expect(preview.rows).toHaveLength(2);
    expect(JSON.stringify(preview.diagnostics)).toContain("steps");

    const view = await createView(savePath(ALICE, defaultViewCompiler), {
      title: "real compiler view",
      definition,
      inputs: inputsOfDefinition(definition),
      lifecycle: "published",
      visibility: "signed-in",
    });
    created.views.push(view);
    const outcome = await runViewAs(real, who(ALICE), view);
    expect(outcome.status).toBe("ok");
    const rows = await s().expectOk(
      `select data->>'name' as name, data->>'n' as n, data->>'total' as total
       from public.entries where dataset_id = ${sqlLit(view)} order by data->>'name'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Alpha", n: "2", total: "15" });
    expect(rows[1]).toMatchObject({ name: "Beta", n: "0" });
    const geoms = await one(
      `select count(*) as n from public.geometries where dataset_id = ${sqlLit(view)}`,
    );
    expect(geoms.n).toBe("2");
    expect(await stale(view)).toBe(false);
  });

  test("views 3 (#301): create from a relation, save, run, rows exist; the derived tables are gone", async () => {
    // "Deployments per state": states 1-N deployments on states.id = deployments.stateId.
    const states = await source({ rows: 0 });
    const deployments = await source({ rows: 0 });
    await s().expectOk(
      `update public.datasets set title = 'States', properties = '["id","name"]'::jsonb where id = ${sqlLit(states)}`,
    );
    await s().expectOk(
      `update public.datasets set title = 'Deployments', properties = '["stateId","cost"]'::jsonb where id = ${sqlLit(deployments)}`,
    );
    await s().expectOk(
      `insert into public.entries (dataset_id, data) values
         (${sqlLit(states)}, '{"id":"s1","name":"Alpha"}'),
         (${sqlLit(states)}, '{"id":"s2","name":"Beta"}'),
         (${sqlLit(deployments)}, '{"stateId":"s1","cost":10}'),
         (${sqlLit(deployments)}, '{"stateId":"s1","cost":5}'),
         (${sqlLit(deployments)}, '{"stateId":"s2","cost":1}')`,
    );
    // The definition "Create view from relation" pre-fills (features/views
    // `definitionFromRelation`; core code cannot import features, so it is
    // spelled out): base = FROM side, one left Join on the relation's keys,
    // summarize with a count for a 1-N relation.
    const seeded = {
      title: "States + Deployments",
      definition: {
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
            matching: { trim: true, caseFold: false, collapseSpace: false, stripDiacritics: false },
            type: "left",
            multiMatch: {
              mode: "summarize",
              measures: [{ as: "deployments_count", fn: "count" }],
            },
          },
        ],
        output: { fields: [], emptyFields: "keep" },
      },
    };
    const view = await createView(savePath(ALICE, defaultViewCompiler), {
      title: seeded.title,
      definition: seeded.definition,
      inputs: inputsOfDefinition(seeded.definition),
      lifecycle: "draft",
      visibility: "members",
    });
    created.views.push(view);

    // Save (save_view) the same definition again, as the editor's Save does.
    await saveView(savePath(ALICE, defaultViewCompiler), view, {
      definition: seeded.definition,
      inputs: inputsOfDefinition(seeded.definition),
    });

    const real = runnerDeps({ compiler: defaultViewCompiler });
    const outcome = await runViewAs(real, who(ALICE), view);
    expect(outcome.status).toBe("ok");
    const rows = await s().expectOk(
      `select data->>'name' as name, data->>'deployments_count' as n
       from public.entries where dataset_id = ${sqlLit(view)} order by data->>'name'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Alpha", n: "2" });
    expect(rows[1]).toMatchObject({ name: "Beta", n: "1" });
    expect(await stale(view)).toBe(false);

    // The legacy derived system is gone (migration 0028).
    const gone = await one(`select to_regclass('public.derived_datasets') as t`);
    expect(gone.t).toBeNull();

    // A dataset a view still reads cannot be deleted; the dependents are listable by title.
    const dependents = await s().expectOk(
      `select v.title from public.view_inputs vi join public.datasets v on v.id = vi.view_id
       where vi.input_dataset_id = ${sqlLit(states)}`,
    );
    expect(dependents.map((row) => row.title)).toStrictEqual(["States + Deployments"]);
    const refused = await s().query(`delete from public.datasets where id = ${sqlLit(states)}`);
    expect(refused.error).toMatch(/foreign key|23503|violates/);
  });
});

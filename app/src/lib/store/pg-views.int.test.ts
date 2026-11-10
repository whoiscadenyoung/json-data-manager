// Integration tests — Views schema, two-phase runner, previews, staleness
// (issue #300; migration 0027_views.sql; docs/views-design.md §7/§10).
//
// Same wire-client pattern as the other pg-*.int.test.ts files: the real view
// runner (`#/lib/views/view-runner`) is driven through a `ViewsRpc` adapter
// that issues each RPC as SQL on the test session, roles switched inside a
// test-scoped transaction and rolled back after each test. The compiler is a
// tiny FAKE (the real one is #299): it emits a fixed SELECT over the input
// CTE layout, so these tests pin the DATABASE half of the contract.
// Needs a DEDICATED CI-parity db (docs/memory/int-test-db-split-ri-teardown.md).

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CompileInputMeta, ViewCompiler } from "#/lib/views/view-compiler";
import { inputsOfDefinition } from "#/lib/views/view-compiler-wiring";
import {
  createView,
  previewView,
  runView,
  saveView,
  type ViewDeps,
  type ViewsRpc,
} from "#/lib/views/view-runner";

import {
  ALICE,
  BOB,
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

// ---------------------------------------------------------------------------
// The fake compiler and the SQL transport
// ---------------------------------------------------------------------------

/** Definition shape of these tests: design §4's `inputs`, plus a `fail` switch. */
function definitionOver(datasetIds: string[], extra: Record<string, unknown> = {}) {
  return {
    inputs: datasetIds.map((id, i) => ({
      alias: `in${i}`,
      ref: { kind: "dataset", id },
    })),
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
      ? { ok: true, value: definition }
      : { ok: false, errors: [{ path: "", message: "not an object" }] },
  compileView: (definition, inputs, options) => {
    if ("fail" in definition) {
      return {
        sql: "select 1 / 0 as row_id, '{}'::jsonb as d, null::geometry as geom",
        params: [],
      };
    }
    const limit =
      options === undefined || options.limit === undefined ? "" : ` limit ${options.limit}`;
    return {
      sql:
        "select e.id as row_id, e.data as d, g.geom from public.entries e " +
        "left join public.geometries g on g.entry_id = e.id where e.dataset_id = $1" +
        ` order by e.created_at, e.id${limit}`,
      params: [firstId(inputs)],
    };
  },
  compileDiagnostics: (_definition, inputs) => ({
    sql: "select jsonb_build_object('rowsIn', count(*)) as diagnostics from public.entries where dataset_id = $1",
    params: [firstId(inputs)],
  }),
  viewInputDatasetIds: (_definition, inputs) => inputs.map((i) => i.datasetId),
};

function litOf(value: unknown): string {
  if (value !== null && typeof value === "object") return `${sqlLit(value)}::jsonb`;
  return sqlLit(value);
}

/** Each RPC runs as one SQL statement inside a savepoint (an error must not abort the shared test transaction). */
function pgRpc(): ViewsRpc {
  // The wire session cannot pipeline; the runner issues phase-1 reads in
  // parallel (separate connections in production), so serialize them here.
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = async (work: () => Promise<unknown>): Promise<unknown> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return await run;
  };
  return {
    call: async (fn, args) =>
      await serialized(async () => {
        const named = Object.entries(args)
          .map(([key, value]) => `${key} => ${litOf(value)}`)
          .join(", ");
        const sp = `sp_${crypto.randomUUID().replaceAll("-", "")}`;
        await s().expectOk(`savepoint ${sp}`);
        const result = await s().query(`select public.${fn}(${named}) as r`);
        if (result.error !== undefined) {
          await s().expectOk(`rollback to ${sp}`);
          await s().expectOk(`release ${sp}`);
          throw new Error(result.error);
        }
        await s().expectOk(`release ${sp}`);
        const row = result.rows[0];
        const raw = row === undefined ? null : row.r;
        return raw === null || raw === undefined ? null : parseMaybeJson(raw);
      }),
  };
}

function parseMaybeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function deps(): ViewDeps {
  return { rpc: pgRpc(), compiler: fakeCompiler };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  extra: { editPolicy?: "open" | "locked"; fail?: boolean } = {},
): Promise<string> {
  await s().asUser(ALICE);
  const definition = definitionOver(inputIds, extra.fail === true ? { fail: true } : {});
  return await createView(deps(), {
    title: "fixture view",
    definition,
    inputs: inputsOfDefinition(definition),
    lifecycle: "published",
    visibility: "signed-in",
    editPolicy: extra.editPolicy ?? "open",
  });
}

async function one(sql: string): Promise<Record<string, string | null>> {
  const rows = await s().expectOk(sql);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${sql}`);
  return row;
}

async function stale(viewId: string): Promise<boolean> {
  const row = await one(
    `select public.view_stale(d) as v from public.datasets d where d.id = ${sqlLit(viewId)}`,
  );
  return row.v === "t";
}

async function expectRaises(text: string): Promise<string> {
  const sp = `sp_${crypto.randomUUID().replaceAll("-", "")}`;
  await s().expectOk(`savepoint ${sp}`);
  const result = await s().query(text);
  await s().expectOk(`rollback to ${sp}`);
  await s().expectOk(`release ${sp}`);
  if (result.error !== undefined) return result.error;
  throw new Error(`expected the statement to raise: ${text}`);
}

describe.skipIf(!dbUp())("views (#300)", () => {
  test("a run writes rows and geometries and bumps the tile cache version", async () => {
    await s().begin();
    const input = await source({ rows: 5, geometry: true });
    const view = await newView([input]);
    const before = await one(
      `select map_tile_cache_version::int as v from public.datasets where id = ${sqlLit(view)}`,
    );

    const outcome = await runView(deps(), view);
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
    // The ferried geometry is a real, indexed geometry.
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
    const second = await runView(deps(), view);
    expect(second.status).toBe("ok");
    const again = await one(
      `select map_tile_cache_version::int as v from public.datasets where id = ${sqlLit(view)}`,
    );
    expect(again.v).toBe(after.v);
  });

  test("stale flips after an input edit", async () => {
    await s().begin();
    const input = await source({ rows: 3 });
    const view = await newView([input]);
    expect(await stale(view)).toBe(true); // never run

    await runView(deps(), view);
    expect(await stale(view)).toBe(false);

    await s().asAdmin();
    await s().expectOk(
      `insert into public.entries (dataset_id, data) values (${sqlLit(input)}, '{"name":"late"}')`,
    );
    await s().asUser(ALICE);
    expect(await stale(view)).toBe(true);

    expect((await runView(deps(), view)).status).toBe("ok");
    expect(await stale(view)).toBe(false);
    const rows = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(rows.n).toBe("4");
  });

  test("the catalog summary select reads the stale flag as a field", async () => {
    await s().begin();
    const input = await source({ rows: 1 });
    const view = await newView([input]);
    const row = await one(
      `select kind, refresh_mode, public.view_stale(d) as stale from public.datasets d where id = ${sqlLit(view)}`,
    );
    expect(row.kind).toBe("view");
    expect(row.refresh_mode).toBe("manual");
    expect(row.stale).toBe("t");
    const src = await one(
      `select public.view_stale(d) as stale from public.datasets d where id = ${sqlLit(input)}`,
    );
    expect(src.stale).toBe("f");
  });

  test("a viewer cannot run (and nothing is recorded)", async () => {
    await s().begin();
    const input = await source({ rows: 2 });
    const view = await newView([input], { editPolicy: "locked" });
    await s().asUser(BOB);
    await expect(runView(deps(), view)).rejects.toThrow(/not writable/);
    await s().asAdmin();
    const runs = await one(
      `select count(*) as n from public.view_runs where view_id = ${sqlLit(view)}`,
    );
    expect(runs.n).toBe("0");
    // ...and Bob cannot read the run history even of a run Alice makes.
    await s().asUser(ALICE);
    await runView(deps(), view);
    await s().asUser(BOB);
    const visible = await one(
      `select count(*) as n from public.view_runs where view_id = ${sqlLit(view)}`,
    );
    expect(visible.n).toBe("0");
  });

  test("a failed run keeps the previous rows and records the error", async () => {
    await s().begin();
    const input = await source({ rows: 4 });
    const view = await newView([input]);
    expect((await runView(deps(), view)).status).toBe("ok");

    const broken = definitionOver([input], { fail: true });
    await saveView(deps(), view, { definition: broken, inputs: inputsOfDefinition(broken) });
    const outcome = await runView(deps(), view);
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

  test("a cycle is rejected", async () => {
    await s().begin();
    const input = await source({ rows: 1 });
    const a = await newView([input]);
    const b = await newView([a]); // b reads a: fine
    const cyclic = definitionOver([b]);
    await expect(
      saveView(deps(), a, { definition: cyclic, inputs: inputsOfDefinition(cyclic) }),
    ).rejects.toThrow(/cycle/);
    const self = definitionOver([a]);
    await expect(
      saveView(deps(), a, { definition: self, inputs: inputsOfDefinition(self) }),
    ).rejects.toThrow(/cycle/);
    // The refused saves left a's inputs untouched.
    const inputs = await one(
      `select input_dataset_id::text as i from public.view_inputs where view_id = ${sqlLit(a)}`,
    );
    expect(inputs.i).toBe(input);
  });

  test("preview returns at most 50 rows plus full-input diagnostics", async () => {
    await s().begin();
    const input = await source({ rows: 120 });
    await s().asUser(ALICE);
    const definition = definitionOver([input]);
    const preview = await previewView(deps(), {
      definition,
      inputs: inputsOfDefinition(definition),
    });
    expect(preview.rows).toHaveLength(50);
    expect(preview.diagnostics).toEqual({ rowsIn: 120 });
  });

  test("a view over an UNPUBLISHED draft input works; an invisible input is refused", async () => {
    await s().begin();
    const draft = await source({ lifecycle: "draft", rows: 3 });
    const view = await newView([draft]);
    const outcome = await runView(deps(), view);
    expect(outcome.status).toBe("ok");

    // Bob cannot see Alice's members-only draft, so he cannot build on it.
    await s().asUser(BOB);
    const definition = definitionOver([draft]);
    await expect(
      createView(deps(), { title: "nope", definition, inputs: inputsOfDefinition(definition) }),
    ).rejects.toThrow(/not visible/);
  });

  test("a view's rows are written only by its run", async () => {
    await s().begin();
    const input = await source({ rows: 2 });
    const view = await newView([input]);
    await runView(deps(), view);

    // Direct writes, as the owner and as an admin: all refused.
    expect(
      await expectRaises(
        `insert into public.entries (dataset_id, data) values (${sqlLit(view)}, '{}')`,
      ),
    ).toMatch(/is a view/);
    expect(
      await expectRaises(
        `update public.entries set data = '{}' where dataset_id = ${sqlLit(view)}`,
      ),
    ).toMatch(/is a view/);
    expect(
      await expectRaises(`delete from public.entries where dataset_id = ${sqlLit(view)}`),
    ).toMatch(/is a view/);
    expect(
      await expectRaises(
        `select public.import_entries(${sqlLit(view)}, '[{"data":{"a":1}}]'::jsonb)`,
      ),
    ).toMatch(/is a view/);
    await s().asAdmin();
    expect(
      await expectRaises(
        `insert into public.entries (dataset_id, data) values (${sqlLit(view)}, '{}')`,
      ),
    ).toMatch(/is a view/);

    // A client cannot mint a view directly either.
    await s().asUser(ALICE);
    await expectRaises(
      `insert into public.datasets (title, kind, definition, refresh_mode, created_by)
       values ('x', 'view', '{}', 'manual', ${sqlLit(ALICE)})`,
    );

    // Dropping the view itself cascades through the guard.
    await s().asAdmin();
    await s().expectOk(`delete from public.datasets where id = ${sqlLit(view)}`);
    const left = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(left.n).toBe("0");
  });

  test("view_query: one statement, read-only, bind params, timeout from the caller", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const ok = await one(
      `select public.view_query('select $1::int + 1 as x', '[41]'::jsonb)::text as r`,
    );
    expect(JSON.parse(ok.r ?? "")).toEqual({ rows: [{ x: 42 }], rowCount: 1 });

    expect(await expectRaises(`select public.view_query('select 1; select 2')`)).toMatch(
      /exactly one statement/,
    );
    expect(await expectRaises(`select public.view_query('select 1; set session x.y = 1')`)).toMatch(
      /exactly one statement/,
    );
    // A semicolon inside a literal is fine.
    await s().expectOk(`select public.view_query($q$select 'a;b' as t$q$)`);
    // Writes are refused by the read-only transaction, flags restored after.
    expect(
      await expectRaises(
        `select public.view_query('insert into public.imports (dataset_id) values (null) returning 1')`,
      ),
    ).toMatch(/read-only/);
    expect(
      await expectRaises(
        `select public.view_query('select set_config(''transaction_read_only'', ''off'', true)')`,
      ),
    ).toMatch(/read-write/);
    const mode = await one(`select current_setting('transaction_read_only') as m`);
    expect(mode.m).toBe("off");

    await s().expectOk(`set local statement_timeout = '200ms'`);
    expect(await expectRaises(`select public.view_query('select pg_sleep(3)')`)).toMatch(/timeout/);
    await s().expectOk(`set local statement_timeout = 0`);
    const leftover = await one(
      `select count(*) as n from pg_prepared_statements where name like 'jdm_view_%'`,
    );
    expect(leftover.n).toBe("0");
  });
});

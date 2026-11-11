// Integration tests — view refresh modes `auto` and `live` (issue #305;
// migration 0029_views_refresh.sql; docs/views-design.md §7).
//
// Same harness as pg-views.int.test.ts: the runner under test is the real one
// and opens its own connections, so fixtures are COMMITTED and removed in
// afterEach. The compiler is a tiny fake; a definition carries `steps` so the
// live gate (spatial refusal) has something to look at. Needs a DEDICATED
// CI-parity db (docs/memory/int-test-db-split-ri-teardown.md).

import type { Step } from "@caden/data-core/views";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CompileInputMeta, ViewCompiler, ViewDefinition } from "#/lib/views/view-compiler";
import { inputsOfDefinition } from "#/lib/views/view-compiler-wiring";
import { createView, type ViewDeps, type ViewsRpc } from "#/lib/views/view-save";
import type { VerifiedClaims } from "#/server/views/claims";
import { connect } from "#/server/views/entry.server";
import { drainRefreshQueue, readLiveAs, setRefreshModeAs } from "#/server/views/refresh";
import { runViewAs, type RunnerDeps } from "#/server/views/runner";

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
  for (const id of created.views.toReversed()) {
    await session.expectOk(`delete from public.datasets where id = ${sqlLit(id)}`);
  }
  await dropDatasets(session, created.sources);
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_SPATIAL = { kind: "stub-spatial" };

function firstId(inputs: CompileInputMeta[]): string {
  const first = inputs[0];
  if (first === undefined) throw new Error("no inputs");
  return first.datasetId;
}

const fakeCompiler: ViewCompiler = {
  validateViewDefinition: (definition) =>
    typeof definition === "object" && definition !== null
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake compiler accepts any object as a "definition".
        { ok: true, value: definition as ViewDefinition }
      : { ok: false, errors: [{ path: "", message: "not an object" }] },
  compileView: (_definition, inputs) => ({
    sql:
      "select e.id as row_id, e.data as d, g.geom from public.entries e " +
      "left join public.geometries g on g.entry_id = e.id where e.dataset_id = $1::uuid " +
      "order by e.created_at, e.id",
    params: [firstId(inputs)],
  }),
  compileDiagnostics: (_definition, inputs) => ({
    sql: "select jsonb_build_object('rowsIn', count(*)) as diagnostics from public.entries where dataset_id = $1::uuid",
    params: [firstId(inputs)],
  }),
  viewInputDatasetIds: (_definition, inputs) => inputs.map((i) => i.datasetId),
};

function who(userId: string): VerifiedClaims {
  return { sub: userId, role: "authenticated", claims: { sub: userId, role: "authenticated" } };
}

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  if (runnerSql === undefined) throw new Error("no db");
  return { sql: runnerSql, compiler: fakeCompiler, timeoutMs: 30_000, ...extra };
}

function litOf(value: unknown): string {
  if (value !== null && typeof value === "object") return `${sqlLit(value)}::jsonb`;
  return sqlLit(value);
}

/** The save-path RPCs, issued as `userId` in one short COMMITTED transaction each. */
function savePath(userId: string): ViewDeps {
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
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
  return { rpc, compiler: fakeCompiler };
}

async function source(opts: { rows: number; draft?: boolean }) {
  await s().asAdmin();
  const id = await createDataset(s(), {
    createdBy: ALICE,
    lifecycle: opts.draft === true ? "draft" : "published",
    visibility: opts.draft === true ? "members" : "signed-in",
  });
  created.sources.push(id);
  if (opts.rows > 0) {
    await s().expectOk(
      `insert into public.entries (dataset_id, data)
       select ${sqlLit(id)}, jsonb_build_object('name', 'row ' || g) from generate_series(1, ${opts.rows}) g`,
    );
  }
  return id;
}

async function newView(
  inputId: string,
  extra: {
    editPolicy?: "open" | "locked";
    visibility?: "members" | "signed-in";
    steps?: unknown[];
  } = {},
): Promise<string> {
  const definition = {
    inputs: [{ alias: "in0", ref: { kind: "dataset", id: inputId } }],
    steps: extra.steps ?? [],
  };
  const id = await createView(savePath(ALICE), {
    title: "refresh fixture",
    definition,
    inputs: inputsOfDefinition(definition),
    lifecycle: "published",
    visibility: extra.visibility ?? "signed-in",
    editPolicy: extra.editPolicy ?? "open",
  });
  created.views.push(id);
  return id;
}

async function rows(sql: string): Promise<Record<string, string | null>[]> {
  await s().asAdmin();
  return await s().expectOk(sql);
}

async function one(sql: string): Promise<Record<string, string | null>> {
  const found = (await rows(sql))[0];
  if (found === undefined) throw new Error(`no row: ${sql}`);
  return found;
}

async function addInputRow(inputId: string, name: string): Promise<void> {
  await rows(
    `insert into public.entries (dataset_id, data) values (${sqlLit(inputId)}, ${sqlLit({ name })}::jsonb)`,
  );
}

async function queueRows(viewId: string): Promise<number> {
  const r = await one(
    `select count(*) as n from public.view_refresh_queue where view_id = ${sqlLit(viewId)}`,
  );
  return Number(r.n);
}

async function okRuns(viewId: string): Promise<number> {
  const r = await one(
    `select count(*) as n from public.view_runs where view_id = ${sqlLit(viewId)} and status = 'ok'`,
  );
  return Number(r.n);
}

async function makeDue(viewId: string): Promise<void> {
  await rows(
    `update public.view_refresh_queue set due_at = now() - interval '1 second' where view_id = ${sqlLit(viewId)}`,
  );
}

async function raisesAs(userId: string, text: string): Promise<string> {
  await s().begin();
  await s().asUser(userId);
  const result = await s().query(text);
  await s().rollback();
  if (result.error !== undefined) return result.error;
  throw new Error(`expected the statement to raise: ${text}`);
}

describe.skipIf(!dbUp())("auto refresh (#305)", () => {
  test("a burst of input edits causes exactly one auto refresh", async () => {
    const input = await source({ rows: 3 });
    const view = await newView(input);
    expect((await runViewAs(deps(), who(ALICE), view)).status).toBe("ok");
    await setRefreshModeAs(deps(), who(ALICE), view, "auto");
    const mode = await one(
      `select refresh_mode, auto_refresh_by from public.datasets where id = ${sqlLit(view)}`,
    );
    expect(mode.refresh_mode).toBe("auto");
    expect(mode.auto_refresh_by).toBe(ALICE);
    expect(await queueRows(view)).toBe(0); // fresh: nothing to catch up on

    for (let i = 0; i < 5; i += 1) {
      await addInputRow(input, `burst ${i}`);
    }
    expect(await queueRows(view)).toBe(1); // coalesced into one pending refresh

    // Inside the window nothing runs.
    expect(await drainRefreshQueue(deps())).toStrictEqual([]);
    expect(await okRuns(view)).toBe(1);

    await makeDue(view);
    const reports = await drainRefreshQueue(deps());
    expect(reports).toStrictEqual([{ viewId: view, runAs: ALICE, status: "ok" }]);
    expect(await okRuns(view)).toBe(2);
    const entries = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(entries.n).toBe("8");

    // Drained: no leftovers, and a second drain is a no-op.
    expect(await queueRows(view)).toBe(0);
    expect(await drainRefreshQueue(deps())).toStrictEqual([]);
    expect(await okRuns(view)).toBe(2);
  });

  test("an edit that lands while a refresh is running re-queues exactly one more", async () => {
    const input = await source({ rows: 1 });
    const view = await newView(input);
    await runViewAs(deps(), who(ALICE), view);
    await setRefreshModeAs(deps(), who(ALICE), view, "auto");
    await addInputRow(input, "first");
    await makeDue(view);
    // Claim by hand (as a worker would), edit mid-run, then finish.
    const claimed = await rows(`select * from public.view_refresh_claim(5)`);
    expect(claimed).toHaveLength(1);
    await addInputRow(input, "second");
    await addInputRow(input, "third");
    const mid = await one(
      `select claimed_at is not null as claimed, redo_at is not null as redo from public.view_refresh_queue where view_id = ${sqlLit(view)}`,
    );
    expect(mid).toMatchObject({ claimed: "t", redo: "t" });
    // A second worker cannot claim it while it runs (single flight).
    expect(await rows(`select * from public.view_refresh_claim(5)`)).toHaveLength(0);
    await rows(`select public.view_refresh_finish(${sqlLit(view)}::uuid)`);
    expect(await queueRows(view)).toBe(1);
    await makeDue(view);
    expect((await drainRefreshQueue(deps())).map((r) => r.status)).toStrictEqual(["ok"]);
    expect(await queueRows(view)).toBe(0);
  });

  test("auto with a revoked identity records an error and keeps the rows", async () => {
    const input = await source({ rows: 2 });
    const view = await newView(input, { editPolicy: "open" });
    await runViewAs(deps(), who(ALICE), view);
    // BOB (an editor while the policy is open) turns auto on: the runs are BOB's.
    await setRefreshModeAs(deps(), who(BOB), view, "auto");
    expect(
      (await one(`select auto_refresh_by from public.datasets where id = ${sqlLit(view)}`))
        .auto_refresh_by,
    ).toBe(BOB);

    // BOB loses access: only the creator may edit now.
    await rows(`update public.datasets set edit_policy = 'locked' where id = ${sqlLit(view)}`);
    await addInputRow(input, "late");
    await makeDue(view);
    const reports = await drainRefreshQueue(deps());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ viewId: view, runAs: BOB, status: "error" });

    const failed = await one(
      `select status, error, created_by from public.view_runs where view_id = ${sqlLit(view)} and status = 'error'`,
    );
    expect(failed.error).toMatch(/not writable|auto refresh/);
    expect(failed.created_by).toBe(BOB);
    // The last good rows survive.
    const entries = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(entries.n).toBe("2");
    expect(await okRuns(view)).toBe(1);
    expect(await queueRows(view)).toBe(0);
  });

  test("a pinned-free manual view is never queued, and leaving auto clears the queue", async () => {
    const input = await source({ rows: 1 });
    const view = await newView(input);
    await addInputRow(input, "x");
    expect(await queueRows(view)).toBe(0);

    await setRefreshModeAs(deps(), who(ALICE), view, "auto"); // never ran: stale, queued now
    expect(await queueRows(view)).toBe(1);
    await setRefreshModeAs(deps(), who(ALICE), view, "manual");
    expect(await queueRows(view)).toBe(0);
    const mode = await one(
      `select refresh_mode, auto_refresh_by from public.datasets where id = ${sqlLit(view)}`,
    );
    expect(mode).toMatchObject({ refresh_mode: "manual", auto_refresh_by: null });
  });

  test("auto and live can only be set through the runner-only function", async () => {
    const input = await source({ rows: 1 });
    const view = await newView(input);
    const direct = await raisesAs(
      ALICE,
      `select public.set_view_refresh_mode(${sqlLit(view)}::uuid, 'auto')`,
    );
    expect(direct).toMatch(/permission denied/);
    const viaSave = await raisesAs(
      ALICE,
      `select public.save_view(${sqlLit(view)}::uuid, '{"inputs":[],"steps":[]}'::jsonb,
         ${sqlLit([{ alias: "in0", datasetId: input }])}::jsonb, 'live')`,
    );
    expect(viaSave).toMatch(/set_view_refresh_mode/);
    const viaCreate = await raisesAs(
      ALICE,
      `select public.create_view('t', '{}'::jsonb, ${sqlLit([{ alias: "in0", datasetId: input }])}::jsonb, 'auto')`,
    );
    expect(viaCreate).toMatch(/manual mode/);
    expect(
      (await one(`select refresh_mode from public.datasets where id = ${sqlLit(view)}`))
        .refresh_mode,
    ).toBe("manual");
  });
});

describe.skipIf(!dbUp())("live views (#305)", () => {
  test("a live read reflects an input edit immediately and saves no rows", async () => {
    const input = await source({ rows: 3 });
    const view = await newView(input);
    await setRefreshModeAs(deps(), who(ALICE), view, "live");

    const first = await readLiveAs(deps(), who(ALICE), view);
    expect(first.rows).toHaveLength(3);
    expect(first.truncated).toBe(false);

    await addInputRow(input, "just now");
    const second = await readLiveAs(deps(), who(ALICE), view);
    expect(second.rows).toHaveLength(4);
    expect(JSON.stringify(second.rows)).toContain("just now");

    const saved = await one(
      `select count(*) as n from public.entries where dataset_id = ${sqlLit(view)}`,
    );
    expect(saved.n).toBe("0");
    // Never stale: nothing is saved to go stale; and it is not queued.
    const stale = await one(
      `select public.view_stale(d) as v from public.datasets d where d.id = ${sqlLit(view)}`,
    );
    expect(stale.v).toBe("f");
    expect(await queueRows(view)).toBe(0);
    // An editor's read mirrors the declared columns for the table.
    const meta = await one(
      `select properties::text as p from public.datasets where id = ${sqlLit(view)}`,
    );
    expect(meta.p).toBe('["name"]');
  });

  test("a live read is capped and flags truncation", async () => {
    const input = await source({ rows: 5 });
    const view = await newView(input);
    await setRefreshModeAs(deps(), who(ALICE), view, "live");
    const read = await readLiveAs(deps({ liveRowCap: 3 }), who(ALICE), view);
    expect(read.rows).toHaveLength(3);
    expect(read.truncated).toBe(true);
    expect(read.rowCap).toBe(3);
  });

  test("live is refused when the view has a spatial step (stub)", async () => {
    const input = await source({ rows: 1 });
    const stub = { isSpatialStep: (step: Step) => (step.kind as string) === STUB_SPATIAL.kind };
    const view = await newView(input, { steps: [STUB_SPATIAL] });

    await expect(setRefreshModeAs(deps(stub), who(ALICE), view, "live")).rejects.toThrow(/spatial/);
    expect(
      (await one(`select refresh_mode from public.datasets where id = ${sqlLit(view)}`))
        .refresh_mode,
    ).toBe("manual");
    // With the real hook (no spatial kinds) the same view is allowed...
    await setRefreshModeAs(deps(), who(ALICE), view, "live");
    // ...but every read re-checks, so a kind that turns spatial later is refused.
    await expect(readLiveAs(deps(stub), who(ALICE), view)).rejects.toThrow(/spatial/);
  });

  test("a read of a view that is not live is refused", async () => {
    const input = await source({ rows: 1 });
    const view = await newView(input);
    await expect(readLiveAs(deps(), who(ALICE), view)).rejects.toThrow(/not a live view/);
  });

  test("live reads respect RLS for the reader", async () => {
    const input = await source({ rows: 2, draft: true }); // members-only input (ALICE's)
    const view = await newView(input, { visibility: "signed-in" });
    await setRefreshModeAs(deps(), who(ALICE), view, "live");

    // BOB can see the view but not its input: refused loudly, never zero rows.
    await expect(readLiveAs(deps(), who(BOB), view)).rejects.toThrow(/not visible/);

    // A view BOB cannot see at all reads as not found.
    await rows(`update public.datasets set visibility = 'members' where id = ${sqlLit(view)}`);
    await expect(readLiveAs(deps(), who(BOB), view)).rejects.toThrow(/not found/);

    // The owner still reads it.
    expect((await readLiveAs(deps(), who(ALICE), view)).rows).toHaveLength(2);
  });
});

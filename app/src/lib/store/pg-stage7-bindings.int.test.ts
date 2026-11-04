// Integration tests — stage 7's bound-datasets domain
// (docs/supabase-migration-design.md §3.6/§4/§13 "Stage 7"; issue #206's
// acceptance criteria) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), every statement awaited (the
// single-pipelining lesson), everything rolled back at the end. Skips with a
// one-line message when the stack is unreachable.
//
// The engine's RPCs are SECURITY DEFINER, so an authenticated wire session
// exercises exactly the browser half's surface (store/bindings.ts calls the
// same functions through PostgREST). Coverage here:
//   * the §4 matrix rows: SELECT authenticated on all six tables; the
//     engine-owned five carry no browser writes (the 0009 revoke pattern —
//     permission denied, not policy-filtered); dataset_bindings CRUD answers
//     can_edit_dataset of the bound dataset, with the 0008-shape
//     INSERT .. RETURNING check (flat SELECT policy answers the read-back);
//   * the bound-dataset read-only rule: the RESTRICTIVE policies on
//     entries/geometries/imports refuse direct row writes on a dataset
//     carrying the `source` marker while can_edit_dataset stays untouched
//     (a non-bound dataset still accepts the same writes);
//   * the engine end-to-end: a full pass (keyed applies, delete detection by
//     the sweep, activity row) and a commit-tail pass (keyed ops, geometry
//     rebuilt from the declared latLng mapping, the unmapped `update` flagging
//     needs_reconcile, the mirror idempotent on replay, the History feed);
//   * the lease: batches under a stale claim raise, cron-created runs (claim
//     null) are claimed by binding_claim_run, and the collect attempt budget
//     fails a run instead of reviving it forever;
//   * keep-N/pin retention honored through complete_run (the binding's
//     knobs mirror into version_policies, stage-4 enforcement retires
//     past-keep versions, consumer-pinned versions are exempt);
//   * the weekly reconcile: the pg_cron job row exists (Mondays 09:00 UTC)
//     and binding_schedule_reconciles creates unclaimed reconcile runs that
//     skip bindings with an active run;
//   * unbind: creator-only, deletes the projection + every sync-state row;
//   * the 0009-limitation hardening: publish_version REFUSES a dataset
//     carrying storage-backed oversized geometry (source null + source_path
//     set) instead of freezing it half-geometry'd — and freezes cleanly
//     without one.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

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

/** A row's cell, or a loud failure (the no-optional-chaining test style). */
function cell(row: Record<string, string | null> | undefined, key: string): string | null {
  if (row === undefined) {
    throw new Error("Expected a row.");
  }
  const value = row[key];
  return value === undefined ? null : value;
}

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

// A failed test leaves its transaction open (and aborted); roll it back so
// the next test in the file starts from a clean session.
afterEach(async () => {
  if (session) {
    await session.rollbackIfOpen();
    await session.asAdmin();
  }
});

/** Binds a fresh stand-in dataset for ALICE and returns the binding + dataset ids. */
async function bindStandIn(): Promise<{ bindingId: string; datasetId: string }> {
  const rows = await s().expectOk(`
    select public.binding_ensure(
      'int.stand-in',
      ${sqlLit({
        description: "Int-test bound dataset",
        geometryType: "Point",
        isGeospatial: true,
        jsonSchema: { type: "object" },
        properties: ["label", "lat", "lng"],
        title: "Int bound",
      })}::jsonb,
      ${sqlLit({
        entryKey: "row.id",
        fields: { label: "label" },
        geometry: { kind: "latLng", lat: "lat", lng: "lng" },
      })}::jsonb
    )::text as id`);
  const bindingId = cell(rows[0], "id") ?? "";
  if (bindingId === "") throw new Error("binding_ensure returned no binding id");
  const dsRows = await s().expectOk(
    `select dataset_id::text as id from public.dataset_bindings where id = ${sqlLit(bindingId)}`,
  );
  const datasetId = cell(dsRows[0], "id") ?? "";
  if (datasetId === "") throw new Error("binding has no dataset");
  return { bindingId, datasetId };
}

/** Starts a run (as the signed-in user) and returns its id + claim. */
async function startRun(mode: string): Promise<{ claim: string; runId: string }> {
  const rows = await s().expectOk(
    `select run_id::text as run_id, claim from public.binding_start_run('int.stand-in', ${sqlLit(mode)})`,
  );
  const runId = cell(rows[0], "run_id") ?? "";
  const claim = cell(rows[0], "claim") ?? "";
  if (runId === "" || claim === "") throw new Error("binding_start_run returned no run");
  return { claim, runId };
}

describe("stage 7 — the §4 matrix rows", () => {
  test("bound datasets refuse direct row writes; can_edit_dataset stays untouched", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const { datasetId } = await bindStandIn();
    // The marker + restrictive policies: every data write is refused.
    const marker = await s().expectOk(
      `select source from public.datasets where id = ${sqlLit(datasetId)}`,
    );
    expect(cell(marker[0], "source")).toBe('{"name": "int.stand-in"}');
    expect(
      await s().denied(
        `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, '{"a":1}'::jsonb)`,
      ),
    ).toMatch(/read-only/);
    expect(
      await s().denied(
        `insert into public.geometries (dataset_id, entry_id, source, type) values (${sqlLit(datasetId)}, gen_random_uuid(), '{"type":"Point","coordinates":[0,0]}'::jsonb, 'Point')`,
      ),
    ).toMatch(/read-only/);
    expect(
      await s().denied(`insert into public.imports (dataset_id) values (${sqlLit(datasetId)})`),
    ).toMatch(/read-only/);
    // can_edit_dataset is UNTOUCHED — metadata updates and binding CRUD keep
    // open-dataset semantics (the Convex gate's split).
    const editable = await s().expectOk(
      `select public.can_edit_dataset(${sqlLit(datasetId)}) as ok`,
    );
    expect(cell(editable[0], "ok")).toBe("t");
    await s().expectOk(
      `update public.datasets set description = 'metadata stays editable' where id = ${sqlLit(datasetId)}`,
    );
    await s().rollback();
  });

  test("the engine-owned tables carry no browser writes (permission denied, not filtered)", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const { bindingId, datasetId } = await bindStandIn();
    expect(
      await s().denied(
        `insert into public.sync_runs (binding_id, mode, status) values (${sqlLit(bindingId)}, 'sync', 'collecting')`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await s().denied(
        `insert into public.binding_entries (binding_id, entry_key, entry_id) values (${sqlLit(bindingId)}, 'k', gen_random_uuid())`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await s().denied(
        `insert into public.commit_mirror (binding_id, foreign_commit_id, seq, message, at) values (${sqlLit(bindingId)}, 'fc', 1, 'm', now())`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await s().denied(
        `insert into public.dataset_activity (binding_id, synced_at) values (${sqlLit(bindingId)}, now())`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await s().denied(`insert into public.remote_sources (source) values ('rogue.int')`),
    ).toMatch(/permission denied/);
    // But SELECT is authenticated on all of them.
    for (const table of [
      "remote_sources",
      "dataset_bindings",
      "binding_entries",
      "sync_runs",
      "commit_mirror",
      "dataset_activity",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one assertion per table, in the matrix's order.
      await s().expectOk(`select count(*) from public.${table}`);
    }
    void datasetId;
    await s().rollback();
  });

  test("dataset_bindings INSERT .. RETURNING answers (the 0008 shape on the one browser-writable table)", async () => {
    // The store's binding CRUD path never hand-inserts a binding (the definer
    // bind RPC does), but the policy must hold for the matrix's
    // "bindings' CRUD via can_edit_dataset" — including the RETURNING
    // read-back a `.insert(...).select()` performs: the flat SELECT policy
    // (no definer helper) admits the new row (the 0008 lesson's shape).
    await s().begin();
    await s().asUser(ALICE);
    const { datasetId } = await bindStandIn();
    // Another source + a second dataset the creator owns.
    await s().asAdmin();
    await s().expectOk(`insert into public.remote_sources (source) values ('int.second')`);
    const second = await createDataset(s(), { createdBy: ALICE });
    await s().begin();
    await s().asUser(ALICE);
    const rows = await s().expectOk(
      `insert into public.dataset_bindings (source, dataset_id)
       values ('int.second', ${sqlLit(second)}) returning id::text as id`,
    );
    expect(cell(rows[0], "id")).toBeDefined();
    // A collaborator (BOB) may NOT bind ALICE's open... open datasets are
    // editable by every signed-in user — BOB binding ALICE's dataset is
    // ALLOWED by the matrix (can_edit_dataset true). The denial case is a
    // dataset BOB cannot edit: ALICE's LOCKED dataset.
    await s().asAdmin();
    await s().expectOk(
      `update public.datasets set edit_policy = 'locked' where id = ${sqlLit(second)}`,
    );
    void datasetId;
    await s().asUser(BOB);
    expect(
      await s().denied(
        `insert into public.dataset_bindings (source, dataset_id) values ('int.second', ${sqlLit(second)})`,
      ),
    ).toBeDefined();
    await s().rollback();
  });

  test("anon reads nothing on the stage-7 tables", async () => {
    await s().begin();
    await s().asUser(ALICE);
    await bindStandIn();
    await s().asAnon();
    // RLS filters ROWS, it does not refuse the aggregate: anon counts 0.
    expect(
      cell((await s().expectOk(`select count(*) as n from public.dataset_bindings`))[0], "n"),
    ).toBe("0");
    expect(
      cell((await s().expectOk(`select count(*) as n from public.dataset_activity`))[0], "n"),
    ).toBe("0");
    // Writes are outright denied (permission denied — no grants/policies).
    expect(
      await s().denied(
        `insert into public.dataset_bindings (source, dataset_id) values ('x', gen_random_uuid())`,
      ),
    ).toBeDefined();
    await s().asAdmin();
    await s().rollback();
  });
});

describe("stage 7 — the keyed/resumable engine (the RPC surface)", () => {
  test("a full pass: keyed applies, sweep delete detection, activity row", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const { datasetId, bindingId } = await bindStandIn();
    const { claim, runId } = await startRun("sync");
    expect(
      cell(
        (
          await s().expectOk(
            `select public.binding_mark_collected(${sqlLit(runId)}, ${sqlLit(claim)}, array[]::text[], 2, null, null) as won`,
          )
        )[0],
        "won",
      ),
    ).toBe("t");

    // Batch 1: two rows (one with geometry — the summaries/triggers must fire).
    const batch = await s().expectOk(
      `select public.binding_apply_rows_batch(${sqlLit(runId)}, ${sqlLit(claim)}, 0, 2, ${sqlLit([
        {
          data: { label: "Alpha", lat: 37.1, lng: -76.3 },
          geometry: { coordinates: [-76.3, 37.1], type: "Point" },
          key: "k1",
        },
        { data: { label: "Beta" }, key: "k2" },
      ])}::jsonb) as state`,
    );
    const state = JSON.parse(cell(batch[0], "state") ?? "{}") as Record<string, unknown>;
    expect(state["added"]).toBe(2);
    expect(state["applied"]).toBe(2);

    // Idempotent by key: re-applying the same rows updates nothing.
    const replay = JSON.parse(
      cell(
        (
          await s().expectOk(
            `select public.binding_apply_rows_batch(${sqlLit(runId)}, ${sqlLit(claim)}, 0, 2, ${sqlLit(
              [
                {
                  data: { label: "Alpha", lat: 37.1, lng: -76.3 },
                  geometry: { coordinates: [-76.3, 37.1], type: "Point" },
                  key: "k1",
                },
                { data: { label: "Beta" }, key: "k2" },
              ],
            )}::jsonb) as state`,
          )
        )[0],
        "state",
      ) ?? "{}",
    ) as Record<string, unknown>;
    expect(replay["added"]).toBe(2);
    expect(replay["updated"]).toBe(0);

    // Finalize → sweep: k1 stays (stamped with the run), a map row pointing
    // at a key the run never saw is retired. Seed a stale mapping directly
    // (as the engine owner).
    await s().asAdmin();
    const staleEntry = cell(
      (
        await s().expectOk(
          `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, '{"label":"Ghost"}'::jsonb) returning id::text as id`,
        )
      )[0],
      "id",
    );
    await s().expectOk(
      `insert into public.binding_entries (binding_id, entry_key, entry_id, seen_run) values (${sqlLit(bindingId)}, 'stale-key', ${sqlLit(staleEntry ?? "")}, 'previous-run')`,
    );
    await s().begin();
    await s().asUser(ALICE);
    await s().expectOk(`select public.binding_finalize_run(${sqlLit(runId)}, ${sqlLit(claim)})`);
    const swept = Number(
      cell(
        (await s().expectOk(`select public.binding_sweep_batch(${sqlLit(runId)}) as n`))[0],
        "n",
      ),
    );
    expect(swept).toBe(1);
    const run = await s().expectOk(
      `select status, removed, total from public.sync_runs where id = ${sqlLit(runId)}`,
    );
    expect(cell(run[0], "status")).toBe("completed");
    expect(Number(cell(run[0], "removed"))).toBe(1);
    // The sweep deleted the ghost's ENTRY, not just its map row.
    expect(
      cell(
        (
          await s().expectOk(
            `select count(*) as n from public.entries where id = ${sqlLit(staleEntry ?? "")}`,
          )
        )[0],
        "n",
      ),
    ).toBe("0");
    // The activity row + the binding stamps landed (complete_run).
    const activity = await s().expectOk(
      `select kind, added, removed from public.dataset_activity where binding_id = ${sqlLit(bindingId)} order by synced_at desc limit 1`,
    );
    expect(cell(activity[0], "kind")).toBe("sync");
    expect(Number(cell(activity[0], "added"))).toBe(2);
    const bindingRow = await s().expectOk(
      `select last_synced_at is not null as synced, synced_entry_count from public.dataset_bindings where id = ${sqlLit(bindingId)}`,
    );
    expect(cell(bindingRow[0], "synced")).toBe("t");
    expect(Number(cell(bindingRow[0], "synced_entry_count"))).toBe(2);
    await s().rollback();
  });

  test("a commit-tail pass: keyed ops, latLng geometry rebuild, unmapped update flags needs_reconcile, mirror idempotent", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const { bindingId } = await bindStandIn();
    // Baseline a first full pass so the cursor exists (the tail decision's
    // prerequisite) — a minimal one-batch sync.
    const first = await startRun("sync");
    await s().expectOk(
      `select public.binding_mark_collected(${sqlLit(first.runId)}, ${sqlLit(first.claim)}, array[]::text[], 1, null, null)`,
    );
    await s().expectOk(
      `select public.binding_apply_rows_batch(${sqlLit(first.runId)}, ${sqlLit(first.claim)}, 0, 1, ${sqlLit(
        [
          {
            data: { label: "Alpha", lat: 1, lng: 2 },
            geometry: { coordinates: [2, 1], type: "Point" },
            key: "k1",
          },
        ],
      )}::jsonb)`,
    );
    await s().expectOk(
      `select public.binding_finalize_run(${sqlLit(first.runId)}, ${sqlLit(first.claim)})`,
    );
    await s().expectOk(`select public.binding_sweep_batch(${sqlLit(first.runId)})`);

    const { claim, runId } = await startRun("commit-tail");
    await s().expectOk(
      `select public.binding_mark_collected(${sqlLit(runId)}, ${sqlLit(claim)}, array[]::text[], 1, 'fc-9', 9)`,
    );
    const state = JSON.parse(
      cell(
        (
          await s().expectOk(
            `select public.binding_apply_commits_batch(${sqlLit(runId)}, ${sqlLit(claim)}, 0, 1, ${sqlLit(
              [
                {
                  at: 1_700_000_000_000,
                  foreignCommitId: "fc-9",
                  message: "demo",
                  ops: [
                    {
                      entryKey: "k2",
                      fields: [
                        { after: "Gamma", name: "label" },
                        { after: 3, name: "lat" },
                        { after: 4, name: "lng" },
                      ],
                      geometryChanged: true,
                      op: "add",
                    },
                    {
                      entryKey: "k1",
                      fields: [{ after: "Alpha2", before: "Alpha", name: "label" }],
                      geometryChanged: false,
                      op: "update",
                    },
                    {
                      entryKey: "ghost",
                      fields: [{ after: "x", name: "label" }],
                      geometryChanged: false,
                      op: "update",
                    },
                  ],
                  seq: 9,
                },
              ],
            )}::jsonb) as state`,
          )
        )[0],
        "state",
      ) ?? "{}",
    ) as Record<string, unknown>;
    expect(state["added"]).toBe(1);
    expect(state["updated"]).toBe(1);
    expect(state["needsReconcile"]).toBe(true);
    // k2's entry got a Point rebuilt from the declared latLng mapping.
    const gamma = await s().expectOk(
      `select e.geometry_type, g.source -> 'coordinates' as coords
       from public.entries e
       left join public.geometries g on g.entry_id = e.id
       where e.data ->> 'label' = 'Gamma'`,
    );
    expect(cell(gamma[0], "geometry_type")).toBe("Point");
    expect(cell(gamma[0], "coords")).toBe("[4, 3]");
    // The mirror row landed with the feed's ops verbatim.
    const mirror = await s().expectOk(
      `select foreign_commit_id, seq, message from public.commit_mirror where binding_id = ${sqlLit(bindingId)}`,
    );
    expect(cell(mirror[0], "foreign_commit_id")).toBe("fc-9");
    // Idempotent on (binding_id, foreign_commit_id): the replayed commit
    // mirrors nothing new.
    await s().expectOk(
      `select public.binding_apply_commits_batch(${sqlLit(runId)}, ${sqlLit(claim)}, 0, 1, ${sqlLit(
        [
          {
            at: 1_700_000_000_000,
            foreignCommitId: "fc-9",
            message: "demo",
            ops: [],
            seq: 9,
          },
        ],
      )}::jsonb)`,
    );
    expect(
      cell(
        (
          await s().expectOk(
            `select count(*) as n from public.commit_mirror where binding_id = ${sqlLit(bindingId)}`,
          )
        )[0],
        "n",
      ),
    ).toBe("1");
    // A tail run skips the sweep and completes at finalize — and completion
    // stamps the activity row with the needs_reconcile flag.
    await s().expectOk(`select public.binding_finalize_run(${sqlLit(runId)}, ${sqlLit(claim)})`);
    const run = await s().expectOk(
      `select status, needs_reconcile, last_commit_id, last_seq from public.sync_runs where id = ${sqlLit(runId)}`,
    );
    expect(cell(run[0], "status")).toBe("completed");
    expect(cell(run[0], "needs_reconcile")).toBe("t");
    expect(cell(run[0], "last_commit_id")).toBe("fc-9");
    // now() is transaction-constant, so this pass's activity row and the
    // baseline pass's row TIE on synced_at — select the tail pass's row by
    // its counters (one add + one update).
    const activity = await s().expectOk(
      `select kind, needs_reconcile, updated, removed from public.dataset_activity
       where binding_id = ${sqlLit(bindingId)} and added = 1 and updated = 1 limit 1`,
    );
    expect(cell(activity[0], "kind")).toBe("sync");
    expect(cell(activity[0], "needs_reconcile")).toBe("t");
    await s().rollback();
  });

  test("the lease: batches under a stale claim raise; claim_run takes cron-created runs; the budget fails a poison run", async () => {
    await s().begin();
    await s().asUser(ALICE);
    await bindStandIn();
    const { runId, claim } = await startRun("sync");
    // A batch under the WRONG claim raises (the lease is the gate).
    expect(
      await s().denied(
        `select public.binding_apply_rows_batch(${sqlLit(runId)}, 'not-the-claim', 0, 0, '[]'::jsonb)`,
      ),
    ).toMatch(/not applying under this claim/);

    // A cron-shaped run (claim null) is claimable; a LIVE run is not.
    await s().asAdmin();
    const scheduled = cell(
      (
        await s().expectOk(
          `insert into public.sync_runs (binding_id, mode, status, claim, collect_attempts)
         select id, 'reconcile', 'collecting', null, 0 from public.dataset_bindings where source = 'int.stand-in'
         returning id::text as id`,
        )
      )[0],
      "id",
    );
    await s().begin();
    await s().asUser(ALICE);
    const claimed = cell(
      (
        await s().expectOk(`select public.binding_claim_run(${sqlLit(scheduled ?? "")}) as claim`)
      )[0],
      "claim",
    );
    expect(claimed).not.toBeNull();
    expect(claimed).not.toBe("");
    const secondTry = cell(
      (
        await s().expectOk(`select public.binding_claim_run(${sqlLit(scheduled ?? "")}) as claim`)
      )[0],
      "claim",
    );
    expect(secondTry).toBeNull();

    // The collect budget: revives of the ORIGINAL run fail it (the
    // scheduler would never resurrect it past binding_max_collect_attempts).
    // The claimed scheduled run goes first — both runs share the
    // transaction-constant started_at, so the engine's "latest active run"
    // pick would otherwise be a tie between them.
    await s().asAdmin();
    await s().expectOk(`delete from public.sync_runs where id = ${sqlLit(scheduled ?? "")}`);
    await s().expectOk(
      `update public.sync_runs set last_progress_at = now() - interval '5 minutes' where id = ${sqlLit(runId)}`,
    );
    await s().asUser(ALICE);
    const revive1 = (
      await s().expectOk(
        `select already_running, claim from public.binding_start_run('int.stand-in', 'sync')`,
      )
    )[0];
    expect(cell(revive1, "already_running")).toBe("t");
    await s().asAdmin();
    await s().expectOk(
      `update public.sync_runs set last_progress_at = now() - interval '5 minutes' where id = ${sqlLit(runId)}`,
    );
    await s().asUser(ALICE);
    const revive2 = (
      await s().expectOk(
        `select already_running, claim from public.binding_start_run('int.stand-in', 'sync')`,
      )
    )[0];
    expect(cell(revive2, "already_running")).toBe("t");
    await s().asAdmin();
    await s().expectOk(
      `update public.sync_runs set last_progress_at = now() - interval '5 minutes' where id = ${sqlLit(runId)}`,
    );
    await s().asUser(ALICE);
    const revive3 = (
      await s().expectOk(
        `select already_running, claim from public.binding_start_run('int.stand-in', 'sync')`,
      )
    )[0];
    // The budget is THREE collect schedules total (initial + two revives —
    // MAX_COLLECT_ATTEMPTS): the THIRD kickoff hits it — the run is FAILED
    // and a fresh run starts (already_running false, new run id).
    expect(cell(revive3, "already_running")).toBe("f");
    const failed = await s().expectOk(
      `select status, error from public.sync_runs where id = ${sqlLit(runId)}`,
    );
    expect(cell(failed[0], "status")).toBe("failed");
    expect(cell(failed[0], "error")).toMatch(/giving up/);
    void claim;
    await s().rollback();
  });

  test("the weekly reconcile: the cron job is registered, and the scheduler creates unclaimed work items", async () => {
    await s().begin();
    // The job row (cron lives in its own schema; read as admin).
    await s().asAdmin();
    const job = await s().expectOk(
      `select schedule, command from cron.job where jobname = 'weekly-bindings-reconcile'`,
    );
    expect(cell(job[0], "schedule")).toBe("0 9 * * 1");
    expect(cell(job[0], "command")).toMatch(/binding_schedule_reconciles/);
    await s().asUser(ALICE);
    const { bindingId } = await bindStandIn();
    await s().asAdmin();
    const scheduled = Number(
      cell((await s().expectOk(`select public.binding_schedule_reconciles() as n`))[0], "n"),
    );
    expect(scheduled).toBe(1);
    const run = await s().expectOk(
      `select mode, status, claim from public.sync_runs where binding_id = ${sqlLit(bindingId)} order by started_at desc limit 1`,
    );
    expect(cell(run[0], "mode")).toBe("reconcile");
    expect(cell(run[0], "status")).toBe("collecting");
    expect(cell(run[0], "claim")).toBeNull();
    // A binding with an active run is skipped (no fork).
    const second = Number(
      cell((await s().expectOk(`select public.binding_schedule_reconciles() as n`))[0], "n"),
    );
    expect(second).toBe(0);
    await s().rollback();
  });

  test("keep-N/pin retention is honored through complete_run (the stage-4 machinery)", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const { datasetId, bindingId } = await bindStandIn();
    // Seed a frozen chain of 3 versions (admin — the versions tables carry
    // no client grants) and set the binding's keep-N to 2.
    await s().asAdmin();
    const versionIds: string[] = [];
    let age = 4;
    for (const ref of ["v1", "v2", "v3", "v4"]) {
      // now() is transaction-constant: explicit, distinct freeze times make
      // the retention ranking's recency order (created_at desc) actual.
      const id = cell(
        // oxlint-disable-next-line no-await-in-loop -- one seeded version per ref, in recency order.
        (
          await s().expectOk(
            `insert into public.dataset_versions (dataset_id, ref, publish_key, version_label, lineage, created_by, created_at)
           values (${sqlLit(datasetId)}, ${sqlLit(ref)}, ${sqlLit(`key-${ref}`)}, ${sqlLit(ref)}, '{}'::jsonb, ${sqlLit(ALICE)}, now() - interval '${age} hours')
           returning id::text as id`,
          )
        )[0],
        "id",
      );
      versionIds.push(id ?? "");
      age -= 1;
    }
    await s().expectOk(
      `update public.dataset_bindings set keep_versions = 2 where id = ${sqlLit(bindingId)}`,
    );
    // Pin the OLDEST version through a consumer reference (the exemption).
    await s().expectOk(
      `insert into public.consumer_references (consumer_id, consumer_kind, mode, pinned_version_id, pinned_ref, source_dataset_id)
       values ('int-consumer', 'derived', 'pin', ${sqlLit(versionIds[0] ?? "")}, 'v1', ${sqlLit(datasetId)})`,
    );
    await s().begin();
    await s().asUser(ALICE);
    // Complete a run: the knobs mirror into version_policies and the
    // enforcement runs in the same transaction.
    const { claim, runId } = await startRun("sync");
    await s().expectOk(
      `select public.binding_mark_collected(${sqlLit(runId)}, ${sqlLit(claim)}, array[]::text[], 0, null, null)`,
    );
    await s().expectOk(
      `select public.binding_apply_rows_batch(${sqlLit(runId)}, ${sqlLit(claim)}, 0, 0, '[]'::jsonb)`,
    );
    await s().expectOk(`select public.binding_finalize_run(${sqlLit(runId)}, ${sqlLit(claim)})`);
    await s().expectOk(`select public.binding_sweep_batch(${sqlLit(runId)})`);
    const policy = await s().expectOk(
      `select keep_versions from public.version_policies where dataset_key = ${sqlLit(datasetId)}`,
    );
    expect(Number(cell(policy[0], "keep_versions"))).toBe(2);
    // The stage-4 function ranks UNPINNED versions only (pins live outside
    // the keep-N count): unpinned {v2, v3, v4} keeps the two newest, so v2
    // retires; v1 survives via the pin.
    const surviving = await s().expectOk(
      `select ref from public.dataset_versions where dataset_id = ${sqlLit(datasetId)} order by ref`,
    );
    expect(surviving.map((row) => row.ref)).toEqual(["v1", "v3", "v4"]);
    await s().rollback();
  });
});

describe("stage 7 — the sync-chunks bucket (chunk blobs ride Storage)", () => {
  test("editor + owner write, other user denied, viewable read", async () => {
    // The policies are the 0006 HARDENED shape re-emitted with 'sync-chunks'
    // in the bucket lists (the 0012 storage section): the object's owner
    // stamp must be the writer AND the path's dataset editor.
    await s().begin();
    await s().asUser(ALICE);
    const { datasetId } = await bindStandIn();
    const path = `${datasetId}/sync-runs/run-x/0.json`;
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('sync-chunks', ${sqlLit(path)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );
    // On an OPEN dataset every signed-in user is an editor, so BOB writing
    // his OWN stamp to ALICE's path is a legitimate editor write — the
    // denial case needs a dataset BOB cannot edit: lock it (creator-only).
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.datasets set edit_policy = 'locked' where id = ${sqlLit(datasetId)}`,
    );
    await s().asUser(BOB);
    expect(
      await s().denied(
        `insert into storage.objects (bucket_id, name, owner_id, owner)
         values ('sync-chunks', ${sqlLit(`${datasetId}/sync-runs/run-y/0.json`)}, ${sqlLit(BOB)}, ${sqlLit(BOB)})`,
      ),
    ).toBeDefined();
    // A spoofed owner stamp (writing as BOB claiming ALICE's identity) is
    // denied by the owner arm.
    expect(
      await s().denied(
        `insert into storage.objects (bucket_id, name, owner_id, owner)
         values ('sync-chunks', ${sqlLit(`${datasetId}/sync-runs/run-z/0.json`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
      ),
    ).toBeDefined();
    await s().rollback();
    await s().asAdmin();
  });
});

describe("stage 7 — unbind + the 0009-limitation hardening", () => {
  test("unbind is creator-only and removes the projection + every sync-state row", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const { bindingId, datasetId } = await bindStandIn();
    // BOB (a collaborator on the open dataset) may start syncs but not unbind.
    await s().expectOk(`select public.binding_start_run('int.stand-in', 'sync')`);
    await s().asUser(BOB);
    expect(await s().denied(`select public.binding_unbind(${sqlLit(bindingId)})`)).toMatch(
      /creator/,
    );
    // The creator's unbind deletes the dataset (whose cascade takes the
    // binding and, with it, the runs/activity/mirror/map).
    await s().begin();
    await s().asUser(ALICE);
    await s().expectOk(`select public.binding_unbind(${sqlLit(bindingId)})`);
    expect(
      cell(
        (
          await s().expectOk(
            `select count(*) as n from public.datasets where id = ${sqlLit(datasetId)}`,
          )
        )[0],
        "n",
      ),
    ).toBe("0");
    expect(
      cell(
        (
          await s().expectOk(
            `select count(*) as n from public.dataset_bindings where id = ${sqlLit(bindingId)}`,
          )
        )[0],
        "n",
      ),
    ).toBe("0");
    expect(
      cell(
        (
          await s().expectOk(
            `select count(*) as n from public.dataset_activity where binding_id = ${sqlLit(bindingId)}`,
          )
        )[0],
        "n",
      ),
    ).toBe("0");
    await s().rollback();
  });

  test("publish_version refuses storage-backed oversized geometry, freezes cleanly without it", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const plain = await createDataset(s(), { createdBy: ALICE });
    const { datasetId } = await bindStandIn();
    void datasetId;
    // The oversized row: source NULL + source_path SET (migration 0003's
    // storage-backed shape, > 256 KB).
    await s().asAdmin();
    const entryId = cell(
      (
        await s().expectOk(
          `insert into public.entries (dataset_id, data) values (${sqlLit(plain)}, '{"label":"Big"}'::jsonb) returning id::text as id`,
        )
      )[0],
      "id",
    );
    await s().expectOk(
      `insert into public.geometries (dataset_id, entry_id, source_path, source_bytes, type, bbox)
       values (${sqlLit(plain)}, ${sqlLit(entryId ?? "")}, 'geometries/x/row.json', 999999, 'Point', array[0,0,1,1])`,
    );
    await s().begin();
    await s().asUser(ALICE);
    expect(
      await s().denied(
        `select public.publish_version(${sqlLit(plain)}, 'v1', ${sqlLit(`pk-${crypto.randomUUID()}`)})`,
      ),
    ).toMatch(/storage-backed oversized geometry/);
    // Remove the oversized payload: the guard only refuses the LOSSY freeze
    // (a chain that would silently lose those rows' geometry), never a
    // clean one.
    await s().asAdmin();
    await s().expectOk(`delete from public.geometries where dataset_id = ${sqlLit(plain)}`);
    await s().asUser(ALICE);
    const version = cell(
      (
        await s().expectOk(
          `select public.publish_version(${sqlLit(plain)}, 'v1', ${sqlLit(`pk-${crypto.randomUUID()}`)}) as id`,
        )
      )[0],
      "id",
    );
    expect(version).not.toBeNull();
    await s().rollback();
  });
});

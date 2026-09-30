// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The durable sync engine (sync.ts) — characterization tests (issue #138):
 * full runs, keyed idempotent applies, delete sweeps, the commit-tail
 * primary path, run joining/revival, the mirror bound, and the public
 * queries — driven end to end through `api.sync.*` on a real (test)
 * backend, with the source tables (restaurants/locations/restaurantLocations)
 * and the stand-in commit feed (`sourceCommits`) seeded directly.
 *
 * Five suites are `it.fails` on purpose: they pin the INTENDED behavior of
 * code-confirmed defects tracked in #127, and flip green when that fix
 * lands — never `.skip`:
 * - counters (`added`/`updated`) never move (#127 defect 4);
 * - a full pass over more than the 1,000-row read cap loses the excess
 *   (#127 defect 1);
 * - a tail over the 500-commit read cap applies only the first 500 while
 *   the cursor jumps past them (#127 defect 2);
 * - a collect failure leaves the run stuck in `collecting` instead of
 *   marking it failed (#127 defect 3);
 * - an `update` naming a key with no map row creates a partial entry
 *   holding only the op's after-values (#127 defect 6, reproduced while
 *   writing this suite).
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A fresh test backend with the json-cms component mounted as in the app. */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn() {
  return initTest().withIdentity({ subject: "user-1" });
}

type TestConvex = ReturnType<typeof signedIn>;
type RunRow = NonNullable<FunctionReturnType<typeof api.sync.latestRun>>;
type BindingRow = NonNullable<FunctionReturnType<typeof api.bindings.status>>["binding"];

async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** One restaurant + `count` linked locations; returns the join ids (the projection's keys). */
async function seedLinks(t: TestConvex, count: number): Promise<Array<Id<"restaurantLocations">>> {
  return t.run(async (ctx) => {
    const restaurantId = await ctx.db.insert("restaurants", { cuisine: "Cafe", name: "Probe" });
    const linkIds: Array<Id<"restaurantLocations">> = [];
    for (let index = 0; index < count; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      const locationId = await ctx.db.insert("locations", {
        address: `${index} Main St`,
        city: "Testville",
        label: `L${index}`,
        lat: 30 + index * 0.01,
        lng: -80 - index * 0.01,
        state: "TS",
      });
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      const linkId = await ctx.db.insert("restaurantLocations", { locationId, restaurantId });
      linkIds.push(linkId);
    }
    return linkIds;
  });
}

/** Lands one commit on the stand-in feed (ops name projected rows by their foreign key). */
async function seedCommit(
  t: TestConvex,
  commit: {
    foreignCommitId: string;
    ops: Array<{
      entryKey: string;
      fields: Array<{ after?: unknown; before?: unknown; name: string }>;
      geometryChanged: boolean;
      op: "add" | "delete" | "update";
    }>;
    seq: number;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("sourceCommits", {
      at: 1000,
      foreignCommitId: commit.foreignCommitId,
      message: `commit ${commit.seq}`,
      ops: commit.ops,
      seq: commit.seq,
      source: "restaurantLocations",
    });
  });
}

/** A label-update op on one projected row (the feed's workhorse shape). */
function labelUpdate(entryKey: string, label: string) {
  return {
    entryKey,
    fields: [{ after: label, name: "label" }],
    geometryChanged: false,
    op: "update" as const,
  };
}

/** Full sync over the current tables, drained to completion. */
async function syncNow(t: TestConvex): Promise<FunctionReturnType<typeof api.sync.startRun>> {
  const started = await t.mutation(api.sync.startRun, {
    mode: "sync",
    source: "restaurantLocations",
  });
  await drainScheduled(t);
  return started;
}

/** The latest run row, asserting one exists. */
async function latestRun(t: TestConvex, source = "restaurantLocations"): Promise<RunRow> {
  const run = await t.query(api.sync.latestRun, { source });
  if (run === null) {
    throw new Error("no sync run was recorded");
  }
  return run;
}

/** The binding row (via bindings.status), asserting one exists. */
async function bindingOf(t: TestConvex): Promise<BindingRow> {
  const status = await t.query(api.bindings.status, {});
  if (status === null) {
    throw new Error("no binding exists");
  }
  return status.binding;
}

/** Every projected entry of the bound dataset, as {entryKey, label} pairs (through the commit overlay's map). */
async function projectedEntries(
  t: TestConvex,
): Promise<Array<{ entryKey: string; label: string }>> {
  const binding = await bindingOf(t);
  const map = await t.query(api.sync.commitFeatureMap, { bindingId: binding._id });
  return map.map((row) => ({ entryKey: row.entryKey, label: row.label }));
}

beforeEach(() => {
  vi.useFakeTimers();
});
/** The house lint bans optional chaining — index with an honest failure instead. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`test fixture: nothing at index ${index}`);
  }
  return item;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a full sync run", () => {
  it("projects the source into a bound dataset filed under External demo", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 3);
    await syncNow(t);

    const binding = await bindingOf(t);
    expect(binding.syncedEntryCount).toBe(3);
    const entries = await projectedEntries(t);
    expect(entries.map((entry) => entry.entryKey)).toStrictEqual(linkIds);
    expect(entries.map((entry) => entry.label)).toStrictEqual(["L0", "L1", "L2"]);

    // The run completed with the totals the pass collected.
    const run = await latestRun(t);
    expect(run.status).toBe("completed");
    expect(run.mode).toBe("sync");
    expect(run.applied).toBe(3);
    expect(run.total).toBe(3);
    expect(run.removed).toBe(0);

    // The dataset landed in the shared collection, with the source's title.
    const lists = await t.query(api.bindings.list, {});
    expect(lists).toHaveLength(1);
    expect(at(lists, 0).datasetTitle).toBe("Restaurant locations");
    expect(at(lists, 0).datasetExists).toBe(true);
    expect(at(lists, 0).syncedEntryCount).toBe(3);

    // The History row recorded the adds.
    const history = await t.query(api.bindings.history, { bindingId: binding._id });
    expect(history).toHaveLength(1);
    const activity = history[0];
    expect(activity === undefined ? undefined : activity.kind).toBe("sync");
    expect(activity === undefined ? undefined : activity.entryCount).toBe(3);
    expect(activity === undefined ? [] : activity.ops.map((op) => [op.op, op.label])).toStrictEqual(
      [
        ["add", "L0"],
        ["add", "L1"],
        ["add", "L2"],
      ],
    );
  });

  it("is idempotent: a re-run over unchanged source data writes nothing new", async () => {
    const t = signedIn();
    await seedLinks(t, 2);
    await syncNow(t);
    await syncNow(t);

    const binding = await bindingOf(t);
    expect(binding.syncedEntryCount).toBe(2);
    expect(await projectedEntries(t)).toHaveLength(2);
    const history = await t.query(api.bindings.history, { bindingId: binding._id });
    expect(history).toHaveLength(2);
    const newest = history[0];
    expect(newest === undefined ? [] : newest.ops).toStrictEqual([]);
    expect(newest === undefined ? undefined : newest.removed).toBe(0);
  });

  it("applies source edits keyed (update) and detects source deletes on the sweep", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 2);
    await syncNow(t);

    // Edit one location and delete the other link out from under the projection.
    await t.run(async (ctx) => {
      const link = await ctx.db.get(linkIds[0]);
      if (link === null) {
        throw new Error("fixture link vanished");
      }
      await ctx.db.patch(link.locationId, { label: "Renamed" });
      await ctx.db.delete(linkIds[1]);
    });
    const started = await t.mutation(api.sync.startRun, {
      mode: "reconcile",
      source: "restaurantLocations",
    });
    expect(started.alreadyRunning).toBe(false);
    await drainScheduled(t);

    const entries = await projectedEntries(t);
    expect(entries.map((entry) => entry.entryKey)).toStrictEqual([linkIds[0]]);
    expect(at(entries, 0).label).toBe("Renamed");

    const run = await latestRun(t);
    expect(run.status).toBe("completed");
    expect(run.mode).toBe("reconcile");
    // The sweep's delete IS counted today (the asymmetry #127 flags).
    expect(run.removed).toBe(1);

    const binding = await bindingOf(t);
    expect(binding.lastReconciledAt).toBeDefined();
    const history = await t.query(api.bindings.history, { bindingId: binding._id });
    const activity = history[0];
    expect(activity === undefined ? undefined : activity.kind).toBe("reconcile");
    expect(activity === undefined ? [] : activity.ops.map((op) => [op.op, op.label])).toStrictEqual(
      [
        ["update", "Renamed"],
        ["remove", linkIds[1]],
      ],
    );
    const updateOp = activity === undefined ? undefined : activity.ops[0];
    expect(updateOp === undefined ? undefined : updateOp.detail).toContain("label:");
  });

  it("stamps the binding cursor from the newest commit a full pass observed", async () => {
    const t = signedIn();
    await seedLinks(t, 1);
    await seedCommit(t, { foreignCommitId: "restaurantLocations:1", ops: [], seq: 1 });
    await syncNow(t);
    const binding = await bindingOf(t);
    expect(binding.lastAppliedCommitSeq).toBe(1);
    expect(binding.lastAppliedCommitId).toBe("restaurantLocations:1");
    expect(binding.lastSyncedAt).toBeDefined();
  });

  // #127 defect 4 (✅ code-confirmed): recordActivity pushes ops but never
  // increments tally.added / tally.updated, so runs, activity rows and the
  // dashboard's "last result" always show 0. Intended: the counters reflect
  // what the run did.
  it.fails("counters reflect what a run added and updated (#127)", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 3);
    await syncNow(t);
    let run = await latestRun(t);
    expect(run.added).toBe(3);

    // Edit two rows, add one: the next pass updates 2 and adds 1.
    await t.run(async (ctx) => {
      const first = await ctx.db.get(linkIds[0]);
      const second = await ctx.db.get(linkIds[1]);
      if (first === null || second === null) {
        throw new Error("fixture link vanished");
      }
      await ctx.db.patch(first.locationId, { label: "R0" });
      await ctx.db.patch(second.locationId, { label: "R1" });
      const restaurantId = await ctx.db
        .query("restaurants")
        .withIndex("by_name", (q) => q.eq("name", "Probe"))
        .first();
      if (restaurantId === null) {
        throw new Error("fixture restaurant vanished");
      }
      const locationId = await ctx.db.insert("locations", {
        address: "9 Main St",
        city: "Testville",
        label: "L9",
        lat: 31,
        lng: -81,
        state: "TS",
      });
      await ctx.db.insert("restaurantLocations", { locationId, restaurantId: restaurantId._id });
    });
    await syncNow(t);
    run = await latestRun(t);
    expect(run.updated).toBe(2);
    expect(run.added).toBe(1);
  });

  // #127 defect 1 (✅ code-confirmed): listRows stops at .take(1000) and the
  // finalize sweep deletes nothing the run never saw — rows past the cap are
  // simply never projected. Intended: a full run keeps every row.
  it.fails("a full run over more than the 1,000-row read cap keeps every row (#127)", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 1004);
    await syncNow(t);

    const binding = await bindingOf(t);
    expect(binding.syncedEntryCount).toBe(1004);
    // The rows past the cap (insertion order) are mapped too — the sweep
    // must never consider them stale.
    const lastKeyMapped = await t.run(async (ctx) =>
      ctx.db
        .query("bindingEntries")
        .withIndex("by_binding", (q) =>
          q.eq("bindingId", binding._id).eq("entryKey", linkIds[linkIds.length - 1] ?? ""),
        )
        .first(),
    );
    expect(lastKeyMapped).not.toBeNull();
  });

  it("answers null before any run and validates the source key at start", async () => {
    const t = signedIn();
    expect(await t.query(api.sync.latestRun, { source: "restaurantLocations" })).toBeNull();
    await expect(
      t.mutation(api.sync.startRun, { mode: "sync", source: "not-a-source" }),
    ).rejects.toThrow(/Unknown bound source/);
  });
});

describe("the commit-tail primary path", () => {
  it("prefers the tail once a cursor exists and applies commits in order", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 1);
    await seedCommit(t, { foreignCommitId: "restaurantLocations:1", ops: [], seq: 1 });
    await syncNow(t);

    await seedCommit(t, {
      foreignCommitId: "restaurantLocations:2",
      ops: [labelUpdate(linkIds[0] ?? "", "B2")],
      seq: 2,
    });
    await seedCommit(t, {
      foreignCommitId: "restaurantLocations:3",
      ops: [labelUpdate(linkIds[0] ?? "", "B3")],
      seq: 3,
    });
    await syncNow(t);

    const run = await latestRun(t);
    expect(run.mode).toBe("commit-tail");
    expect(run.status).toBe("completed");
    expect(run.applied).toBe(2);
    // The commits applied in order — the last op's value wins.
    expect(at(await projectedEntries(t), 0).label).toBe("B3");
    // The cursor advanced to the last applied commit.
    expect((await bindingOf(t)).lastAppliedCommitSeq).toBe(3);

    // The applied commits mirror host-side, newest first.
    const binding = await bindingOf(t);
    const mirrors = await t.query(api.sync.listCommits, { bindingId: binding._id });
    expect(mirrors.map((mirror) => mirror.seq)).toStrictEqual([3, 2]);
    const top = mirrors[0];
    expect(top === undefined ? undefined : top.message).toBe("commit 3");
    // The mirror copies the feed's op verbatim — my seeded op carries only
    // the after-value (the before-side enrichment lives in the activity
    // detail, not the mirror).
    const topOp = top === undefined ? undefined : top.ops[0];
    const topField = topOp === undefined ? undefined : topOp.fields[0];
    expect(topField === undefined ? undefined : topField.name).toBe("label");
    expect(topField === undefined ? undefined : topField.after).toBe("B3");
  });

  it("keeps the commit mirror bounded to the newest 200 (and applies everything under the read cap)", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 1);
    await seedCommit(t, { foreignCommitId: "restaurantLocations:1", ops: [], seq: 1 });
    await syncNow(t);
    for (let seq = 2; seq <= 206; seq += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      await seedCommit(t, {
        foreignCommitId: `restaurantLocations:${seq}`,
        ops: [labelUpdate(linkIds[0] ?? "", `label-${seq}`)],
        seq,
      });
    }
    await syncNow(t);

    const run = await latestRun(t);
    expect(run.mode).toBe("commit-tail");
    expect(run.applied).toBe(205);
    expect((await bindingOf(t)).lastAppliedCommitSeq).toBe(206);
    // 205 mirrors landed, then finalize pruned to the newest 200.
    const binding = await bindingOf(t);
    const mirrors = await t.run(async (ctx) =>
      ctx.db
        .query("commits")
        .withIndex("by_binding_seq", (q) => q.eq("bindingId", binding._id))
        .collect(),
    );
    expect(mirrors).toHaveLength(200);
    const seqs = mirrors.map((mirror) => mirror.seq);
    expect(Math.min(...seqs)).toBe(7);
    expect(Math.max(...seqs)).toBe(206);
  });

  // #127 defect 2 (✅ code-confirmed): commitsSince stops at .take(500) but
  // the cursor is stamped from newestCommit(), so pending commits past 500
  // are skipped until the weekly reconcile. Intended: the tail applies all
  // of them and the cursor equals the last applied seq.
  it.fails("a tail over the 500-commit read cap applies them all (#127)", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 1);
    await seedCommit(t, { foreignCommitId: "restaurantLocations:1", ops: [], seq: 1 });
    await syncNow(t);
    for (let seq = 2; seq <= 506; seq += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      await seedCommit(t, {
        foreignCommitId: `restaurantLocations:${seq}`,
        ops: [labelUpdate(linkIds[0] ?? "", `label-${seq}`)],
        seq,
      });
    }
    await syncNow(t);

    const run = await latestRun(t);
    expect(run.status).toBe("completed");
    // All 505 pending commits applied, not just the first 500.
    expect(run.applied).toBe(505);
    // The last applied op's value is on the entry — and the cursor does not
    // skip past unapplied commits.
    expect(at(await projectedEntries(t), 0).label).toBe("label-506");
    expect((await bindingOf(t)).lastAppliedCommitSeq).toBe(506);
  });

  // #127 defect 6 (reproduced live while writing this suite): an `update`
  // naming a key with no map row degrades into an `add` of the op's
  // after-values — an entry without the projection's other fields. Intended:
  // no partial entry (full-state fallback for the key, or a reconcile flag).
  it.fails("an update whose key lost its mapping does not create a partial entry (#127)", async () => {
    const t = signedIn();
    await seedLinks(t, 1);
    await seedCommit(t, { foreignCommitId: "restaurantLocations:1", ops: [], seq: 1 });
    await syncNow(t);
    // The op's entryKey matches no map row (the projection was re-keyed).
    await seedCommit(t, {
      foreignCommitId: "restaurantLocations:2",
      ops: [
        {
          entryKey: "unmapped-foreign-key",
          fields: [{ after: "Orphan", name: "label" }],
          geometryChanged: false,
          op: "update",
        },
      ],
      seq: 2,
    });
    await syncNow(t);

    // The bound dataset still holds exactly the mapped row — no bare entry.
    expect(await projectedEntries(t)).toHaveLength(1);
    expect((await bindingOf(t)).syncedEntryCount).toBe(1);
  });
});

describe("run lifecycle", () => {
  it("joins an active run instead of forking a second one", async () => {
    const t = signedIn();
    await seedLinks(t, 1);
    const first = await t.mutation(api.sync.startRun, {
      mode: "sync",
      source: "restaurantLocations",
    });
    const second = await t.mutation(api.sync.startRun, {
      mode: "sync",
      source: "restaurantLocations",
    });
    expect(second.alreadyRunning).toBe(true);
    expect(first.alreadyRunning).toBe(false);
    expect(second.runId).toBe(first.runId);
    await drainScheduled(t);
    expect((await latestRun(t)).status).toBe("completed");
  });

  it("revives a stale run (dead action) and carries it to completion", async () => {
    const t = signedIn();
    await seedLinks(t, 2);
    const started = await t.mutation(api.sync.startRun, {
      mode: "sync",
      source: "restaurantLocations",
    });
    // Age the checkpoint past the staleness window (2 minutes).
    await t.run(async (ctx) => {
      await ctx.db.patch(started.runId, { lastProgressAt: Date.now() - 3 * 60 * 1000 });
    });
    const rejoined = await t.mutation(api.sync.startRun, {
      mode: "sync",
      source: "restaurantLocations",
    });
    expect(rejoined.alreadyRunning).toBe(true);
    expect(rejoined.runId).toBe(started.runId);
    await drainScheduled(t);
    const run = await latestRun(t);
    expect(run.status).toBe("completed");
    expect((await bindingOf(t)).syncedEntryCount).toBe(2);
  });

  it("reconcileAll kicks one reconcile per binding; the wrapper starts the primary source's sync", async () => {
    const t = signedIn();
    await seedLinks(t, 1);
    const viaWrapper = await t.mutation(api.sync.syncRestaurantLocations, {});
    expect(viaWrapper.alreadyRunning).toBe(false);
    await drainScheduled(t);
    expect((await latestRun(t)).mode).toBe("sync");

    // The weekly drift sweep schedules one reconcile per binding.
    expect(await t.run(async (ctx) => ctx.runMutation(internal.sync.reconcileAll, {}))).toBe(1);
    await drainScheduled(t);
    const run = await latestRun(t);
    expect(run.mode).toBe("reconcile");
    expect((await bindingOf(t)).lastReconciledAt).toBeDefined();
    const history = await t.query(api.bindings.history, { bindingId: (await bindingOf(t))._id });
    expect(at(history, 0).kind).toBe("reconcile");
  });

  // #127 defect 3 (✅ code-confirmed): collectRows has no try/catch — only
  // the apply leg calls markRunFailed — so a collect failure leaves the run
  // in `collecting` forever (revives keep rescheduling it). Intended: the
  // run is marked failed. Forced here by unbinding while a tail run's
  // collect is pending: the collect then finds its binding gone.
  it.fails("a collect failure marks the run failed (#127)", async () => {
    const t = signedIn();
    await seedLinks(t, 1);
    await seedCommit(t, { foreignCommitId: "restaurantLocations:1", ops: [], seq: 1 });
    await syncNow(t);
    // A new commit makes the next sync tail-eligible; start it.
    await seedCommit(t, {
      foreignCommitId: "restaurantLocations:2",
      ops: [labelUpdate(at(await projectedEntries(t), 0).entryKey, "B2")],
      seq: 2,
    });
    const started = await t.mutation(api.sync.startRun, {
      mode: "sync",
      source: "restaurantLocations",
    });
    // The binding (and dataset) vanish before the scheduled collect runs.
    await t.mutation(api.bindings.unbind, { schemaId: (await bindingOf(t)).schemaId });
    await drainScheduled(t);

    const run = await t.run(async (ctx) => ctx.db.get(started.runId));
    expect(run === null ? undefined : run.status).toBe("failed");
  });
});

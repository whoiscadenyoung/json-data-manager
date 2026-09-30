// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The tag-ingest path (tags.ts) — characterization tests (issue #138): the
 * snapshot registry and its action, the pull's worklist, the version
 * projections, compare, retire, and the binding-backed retention policy,
 * driven on a real (test) backend with a synced bound dataset (the sync
 * engine's startRun — the same setup the dashboard uses).
 *
 * Deliberately NOT driven end-to-end here: `ingestSnapshots`'s ingest leg
 * fetches each snapshot file over its storage URL and uploads chunks
 * through an HTTP upload URL. convex-test's storage answers fake URLs
 * (`https://some-deployment.convex.cloud/...`), so the transport cannot run
 * in tests; the suite pins everything around it instead — the projection
 * serialization (`collectProjectionRowsQuery`), the freeze → delta →
 * retention downstream (through the same `internal.versioning` calls the
 * action makes), and the plan-level idempotency. A no-op pull (nothing
 * pending) still runs the real action.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
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

function signedIn(subject = "user-1") {
  return initTest().withIdentity({ subject });
}

type TestConvex = ReturnType<typeof signedIn>;

async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** One restaurant + `count` linked locations (the projection's fixture); returns the join ids. */
async function seedLinks(t: TestConvex, count: number): Promise<string[]> {
  return t.run(async (ctx) => {
    const restaurantId = await ctx.db.insert("restaurants", { cuisine: "Cafe", name: "Probe" });
    const linkIds: string[] = [];
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

/** Syncs the projection into a bound live dataset; returns the binding's dataset id. */
async function bindSource(t: TestConvex, count: number): Promise<string> {
  await seedLinks(t, count);
  await t.mutation(api.sync.startRun, { mode: "sync", source: "restaurantLocations" });
  await drainScheduled(t);
  const status = await t.query(api.bindings.status, {});
  if (status === null) {
    throw new Error("the bound dataset did not materialize");
  }
  return status.binding.schemaId;
}

/** The tag path's snapshot leg minus the HTTP transport: serialize the projection (the same internal query createRestaurantSnapshot stores), plant it in the component's storage, freeze it as one ref. */
async function freezeSnapshot(
  t: TestConvex,
  options: { label: string; ref: string; sourceSchemaId: string },
): Promise<{ alreadyFrozen: boolean; importId?: string; schemaId: string }> {
  const rows = await t.run(async (ctx) =>
    ctx.runQuery(internal.tags.collectProjectionRowsQuery, {}),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
    bytes: bytes.buffer,
  });
  const frozen = await t.run(async (ctx) =>
    ctx.runMutation(internal.versioning.freezeVersion, {
      boundWrite: "tag-ingest",
      chunkStorageIds: [storageId],
      label: options.label,
      ref: options.ref,
      sourceSchemaId: options.sourceSchemaId,
      total: rows.length,
    }),
  );
  await drainScheduled(t);
  return frozen;
}

/** Registers one snapshot row directly (the action's registerSnapshot, which needs no fetch) — for plan-level fixtures. */
async function registerSnapshot(
  t: TestConvex,
  label: string,
  rows: Array<unknown>,
): Promise<{ ref: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const fileStorageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([bytes], { type: "application/jsonl" })),
  );
  return t.run(async (ctx) =>
    ctx.runMutation(internal.tags.registerSnapshot, {
      fileStorageId,
      label,
      rowCount: rows.length,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRestaurantSnapshot (the foreign app's snapshot push)", () => {
  it("serializes the live projection to a registered JSONL file and lists newest first", async () => {
    const t = signedIn();
    await bindSource(t, 2);
    const first = await t.action(api.tags.createRestaurantSnapshot, { label: "  FY22  " });
    expect(first.label).toBe("FY22");
    expect(first.rowCount).toBe(2);
    expect(first.ref.startsWith("snap_")).toBe(true);
    vi.advanceTimersByTime(1000);
    const second = await t.action(api.tags.createRestaurantSnapshot, { label: "FY23" });
    expect(second.ref).not.toBe(first.ref);
    const snapshots = await t.query(api.tags.listSnapshots, {});
    // Newest first, and every snapshot keeps its registered row count.
    expect(snapshots.map((snapshot) => snapshot.ref)).toStrictEqual([second.ref, first.ref]);
    expect(at(snapshots, 1).rowCount).toBe(2);
  });

  it("refuses an empty label", async () => {
    const t = signedIn();
    await bindSource(t, 1);
    await expect(t.action(api.tags.createRestaurantSnapshot, { label: "   " })).rejects.toThrow(
      /label is required/,
    );
  });
});

describe("ingestSnapshots (the pull)", () => {
  it("answers an empty result when there is nothing pending (no fetch legs run)", async () => {
    const t = signedIn();
    await bindSource(t, 1);
    expect(await t.action(api.tags.ingestSnapshots, {})).toStrictEqual({
      failed: [],
      ingested: [],
    });
  });

  it("refuses with no bound dataset to attach versions to", async () => {
    const t = signedIn();
    await expect(t.action(api.tags.ingestSnapshots, {})).rejects.toThrow(/No bound dataset/);
  });
});

describe("ingestPlan (the pull's worklist)", () => {
  it("lists unfrozen snapshots oldest first and skips already-frozen refs", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    const a = await registerSnapshot(t, "a", [{ data: { label: "a" }, geometry: null }]);
    vi.advanceTimersByTime(1000);
    const b = await registerSnapshot(t, "b", [{ data: { label: "b" }, geometry: null }]);

    let plan = await t.run(async (ctx) => ctx.runQuery(internal.tags.ingestPlan, {}));
    expect(plan.sourceSchemaId).toBe(sourceSchemaId);
    expect(plan.snapshots.map((snapshot) => snapshot.ref)).toStrictEqual([a.ref, b.ref]);
    expect(at(plan.snapshots, 0).label).toBe("a");

    // Freezing b's ref (out of order) takes it off the worklist — the
    // global by-ref lookup, not a per-binding scan.
    await freezeSnapshot(t, { label: "b", ref: b.ref, sourceSchemaId });
    plan = await t.run(async (ctx) => ctx.runQuery(internal.tags.ingestPlan, {}));
    expect(plan.snapshots.map((snapshot) => snapshot.ref)).toStrictEqual([a.ref]);
  });
});

describe("version projections over the tag flow", () => {
  it("listVersions returns the light projection newest first with entry counts", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    vi.advanceTimersByTime(1000);
    await freezeSnapshot(t, { label: "v2", ref: "snap_v2", sourceSchemaId });

    const versions = await t.query(api.tags.listVersions, { sourceSchemaId });
    expect(versions).toHaveLength(2);
    const newest = at(versions, 0);
    const oldest = at(versions, 1);
    expect(newest.lineage === undefined ? undefined : newest.lineage.versionLabel).toBe("v2");
    expect(newest.entryCount).toBe(1);
    expect(newest.featureCount).toBe(1);
    expect(oldest.lineage === undefined ? undefined : oldest.lineage.snapshotRef).toBe("snap_v1");
  });

  it("versionEntries serves the frozen rows and getVersionDelta diffs any pair", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    const v1 = await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    // The source grows: a second location, linked and synced.
    await t.run(async (ctx) => {
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
    await t.mutation(api.sync.startRun, { mode: "sync", source: "restaurantLocations" });
    await drainScheduled(t);
    const v2 = await freezeSnapshot(t, { label: "v2", ref: "snap_v2", sourceSchemaId });

    expect(await t.query(api.tags.versionEntries, { schemaId: v1.schemaId })).toHaveLength(1);
    expect(await t.query(api.tags.versionEntries, { schemaId: v2.schemaId })).toHaveLength(2);

    const delta = await t.query(api.tags.getVersionDelta, {
      aSchemaId: v1.schemaId,
      bSchemaId: v2.schemaId,
    });
    expect(delta.added).toBe(1);
    expect(delta.updated).toBe(0);
    expect(delta.removed).toBe(0);
    expect(delta.ops.map((op) => [op.op, op.entryKey])).toStrictEqual([["add", "L9"]]);

    // The reverse pair mirrors the diff direction.
    const back = await t.query(api.tags.getVersionDelta, {
      aSchemaId: v2.schemaId,
      bSchemaId: v1.schemaId,
    });
    expect(back.removed).toBe(1);
    expect(back.added).toBe(0);
  });

  it("an invisible dataset answers as empty to a foreign viewer (stage 8) — versions of public chains stay visible", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    const v1 = await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    // A foreign user's DRAFT row (creator-stamped) — invisible to user-2.
    const foreignDraft = await t.withIdentity({ subject: "user-2" }).run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        actorId: "user-2",
        lifecycle: "draft",
        schema: { properties: { label: { type: "string" } }, title: "Secret", type: "object" },
      }),
    );
    const other = t.withIdentity({ subject: "user-2" });
    // Tag-frozen versions carry no creator stamp and default to catalog
    // visibility — any signed-in collaborator reads them (ADR 0009).
    expect(await other.query(api.tags.versionEntries, { schemaId: v1.schemaId })).toHaveLength(1);
    // An invisible row answers no rows and no delta — indistinguishable
    // from an empty version (the same rule for both). The hidden pair is
    // asked BY user-1 (the original identity): the draft belongs to user-2.
    expect(await other.query(api.tags.versionEntries, { schemaId: foreignDraft })).toStrictEqual(
      [],
    );
    const hidden = await t.query(api.tags.getVersionDelta, {
      aSchemaId: foreignDraft,
      bSchemaId: v1.schemaId,
    });
    expect(hidden).toStrictEqual({ added: 0, ops: [], removed: 0, truncated: false, updated: 0 });
  });
});

describe("retireVersion", () => {
  it("retires a legacy frozen version; the snapshot row stays so the ref can be re-frozen", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    const frozen = await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    expect(await t.query(api.tags.listVersions, { sourceSchemaId })).toHaveLength(1);

    // Tag-frozen rows carry no creator stamp — the lenient legacy rule: any
    // signed-in collaborator may retire (ADR 0009 trust model; #126 notes it).
    await t.withIdentity({ subject: "user-2" }).mutation(api.tags.retireVersion, {
      schemaId: frozen.schemaId,
    });
    expect(await t.query(api.tags.listVersions, { sourceSchemaId })).toStrictEqual([]);

    // The ref is free again: re-freezing produces a NEW version.
    const refrozen = await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    expect(refrozen.alreadyFrozen).toBe(false);
    expect(refrozen.schemaId).not.toBe(frozen.schemaId);
  });

  it("refuses a non-version dataset and answers not-found for a gone id", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    await expect(t.mutation(api.tags.retireVersion, { schemaId: sourceSchemaId })).rejects.toThrow(
      /Only a frozen version dataset can be retired/,
    );
    const gone = await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    await t.mutation(api.tags.retireVersion, { schemaId: gone.schemaId });
    await expect(t.mutation(api.tags.retireVersion, { schemaId: gone.schemaId })).rejects.toThrow(
      /Version dataset not found/,
    );
  });
});

describe("the binding-backed retention policy", () => {
  it("reads the defaults before any policy write, and an invisible anchor answers the defaults too", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    expect(await t.query(api.tags.retentionSettings, { sourceSchemaId })).toStrictEqual({
      keepVersions: 10,
      pinnedRefs: [],
    });
    // A foreign draft anchor is invisible — the defaults, indistinguishable
    // from an unconfigured chain (stage 8).
    const foreignDraft = await t.withIdentity({ subject: "user-2" }).run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        actorId: "user-2",
        lifecycle: "draft",
        schema: { properties: { label: { type: "string" } }, title: "Secret", type: "object" },
      }),
    );
    expect(
      await t.query(api.tags.retentionSettings, { sourceSchemaId: foreignDraft }),
    ).toStrictEqual({ keepVersions: 10, pinnedRefs: [] });
  });

  it("setKeepVersions patches the binding and refuses impossible values or a missing binding", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    await t.mutation(api.tags.setKeepVersions, { keep: 2, sourceSchemaId });
    expect(await t.query(api.tags.retentionSettings, { sourceSchemaId })).toStrictEqual({
      keepVersions: 2,
      pinnedRefs: [],
    });
    await expect(t.mutation(api.tags.setKeepVersions, { keep: 0, sourceSchemaId })).rejects.toThrow(
      /Keep at least one version/,
    );
    await expect(
      t.mutation(api.tags.setKeepVersions, { keep: 2, sourceSchemaId: "no-such-binding" }),
    ).rejects.toThrow(/source binding no longer exists/);
  });

  it("enforces keep-N at the trigger, exempting pinned refs", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    await freezeSnapshot(t, { label: "v1", ref: "snap_v1", sourceSchemaId });
    vi.advanceTimersByTime(1000);
    await freezeSnapshot(t, { label: "v2", ref: "snap_v2", sourceSchemaId });
    vi.advanceTimersByTime(1000);
    await freezeSnapshot(t, { label: "v3", ref: "snap_v3", sourceSchemaId });

    // Pin the OLDEST version, then tighten keep to 2. setKeepVersions
    // enforces immediately: the newest 2 unpinned (v3, v2) survive, and the
    // pinned v1 is exempt — nothing retires.
    const v1Id = await schemaIdOfRef(t, sourceSchemaId, "snap_v1");
    await t.mutation(api.tags.setVersionPinned, { pinned: true, schemaId: v1Id });
    expect(await t.query(api.tags.retentionSettings, { sourceSchemaId })).toStrictEqual({
      keepVersions: 10,
      pinnedRefs: ["snap_v1"],
    });
    await t.mutation(api.tags.setKeepVersions, { keep: 2, sourceSchemaId });
    expect(await t.query(api.tags.retentionSettings, { sourceSchemaId })).toStrictEqual({
      keepVersions: 2,
      pinnedRefs: ["snap_v1"],
    });
    expect(await t.query(api.tags.listVersions, { sourceSchemaId })).toHaveLength(3);

    // Unpin: the next trigger (the ingest's enforceBindingRetention — the
    // same call setKeepVersions just made) retires exactly the oldest
    // unpinned version.
    await t.mutation(api.tags.setVersionPinned, { pinned: false, schemaId: v1Id });
    expect(await t.query(api.tags.retentionSettings, { sourceSchemaId })).toStrictEqual({
      keepVersions: 2,
      pinnedRefs: [],
    });
    const retired = await t.run(async (ctx) =>
      ctx.runMutation(internal.tags.enforceBindingRetention, { sourceSchemaId }),
    );
    expect(retired).toBe(1);
    const after = await t.query(api.tags.listVersions, { sourceSchemaId });
    expect(
      sorted(
        after.map((version) => refOf(version) ?? ""),
        byString,
      ),
    ).toStrictEqual(["snap_v2", "snap_v3"]);
  });

  it("setVersionPinned refuses a non-version dataset and a version without a ref", async () => {
    const t = signedIn();
    const sourceSchemaId = await bindSource(t, 1);
    await expect(
      t.mutation(api.tags.setVersionPinned, { pinned: true, schemaId: sourceSchemaId }),
    ).rejects.toThrow(/Only a frozen version dataset can be pinned/);
  });
});

/** The frozen version holding one ref (test-local lookup through the light projection). */
async function schemaIdOfRef(t: TestConvex, sourceSchemaId: string, ref: string): Promise<string> {
  const versions = await t.query(api.tags.listVersions, { sourceSchemaId });
  const match = versions.find((version) => refOf(version) === ref);
  if (match === undefined) {
    throw new Error(`no frozen version for ref ${ref}`);
  }
  return match.schemaId;
}

/** The house lint bans optional chaining — narrow the light projection's optional ref. */
/** The house lint bans optional chaining — index with an honest failure instead. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`test fixture: nothing at index ${index}`);
  }
  return item;
}

/** Lexicographic string compare (the app's lib target lacks es2023's `toSorted`). */
function byString(a: string, b: string): number {
  return a < b ? -1 : b < a ? 1 : 0;
}

/** A sorted copy — the lib target lacks `toSorted`. */
function sorted<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- a throwaway copy; the lib target lacks toSorted.
  return [...items].sort(compare);
}

function refOf(version: { lineage?: { snapshotRef?: string } }): string | undefined {
  return version.lineage === undefined ? undefined : version.lineage.snapshotRef;
}

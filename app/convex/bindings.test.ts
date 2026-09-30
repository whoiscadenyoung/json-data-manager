// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The binding registry's read side and the unbind flow (bindings.ts) —
 * behavioral coverage beyond the sign-in gate (issue #138). Unbind is the
 * ONE sanctioned way to remove a bound dataset: the projected dataset, its
 * activity history, the projection's key map, the commit mirrors, the run
 * history (with its chunk blobs) all go with it while the source tables are
 * untouched, so a later sync re-creates the projection. The full-removal
 * sweep lives in sync.test.ts (#127 defect 10); here the user-facing
 * contract is pinned.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
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
type Binding = NonNullable<FunctionReturnType<typeof api.bindings.status>>["binding"];

async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** The house lint bans optional chaining — index with an honest failure instead. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`test fixture: nothing at index ${index}`);
  }
  return item;
}

/** One restaurant + `count` linked locations, then a completed sync — the bound projection. */
async function bindSource(t: TestConvex, count = 2): Promise<string> {
  await t.run(async (ctx) => {
    const restaurantId = await ctx.db.insert("restaurants", { cuisine: "Cafe", name: "Probe" });
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
      await ctx.db.insert("restaurantLocations", { locationId, restaurantId });
    }
  });
  await t.mutation(api.sync.startRun, { mode: "sync", source: "restaurantLocations" });
  await drainScheduled(t);
  const status = await t.query(api.bindings.status, {});
  if (status === null) {
    throw new Error("the bound dataset did not materialize");
  }
  return status.binding.schemaId;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reads", () => {
  it("status answers null before the first sync and the binding + dataset after", async () => {
    const t = signedIn();
    expect(await t.query(api.bindings.status, {})).toBeNull();
    const schemaId = await bindSource(t);
    const status = await t.query(api.bindings.status, {});
    if (status === null) {
      throw new Error("binding vanished");
    }
    expect(status.binding.schemaId).toBe(schemaId);
    expect(status.binding.source).toBe("restaurantLocations");
    expect(status.schema === null ? undefined : status.schema.title).toBe("Restaurant locations");
  });

  it("list carries the dataset's title and existence (a vanished dataset still lists)", async () => {
    const t = signedIn();
    expect(await t.query(api.bindings.list, {})).toStrictEqual([]);
    const schemaId = await bindSource(t);
    const rows = await t.query(api.bindings.list, {});
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).datasetTitle).toBe("Restaurant locations");
    expect(at(rows, 0).datasetExists).toBe(true);
    expect(at(rows, 0).syncedEntryCount).toBe(2);

    // A binding whose dataset vanished mid-unbind still lists — with
    // nothing to show. (Delete the dataset out from under the binding, the
    // way a crashed unbind would leave it.)
    await t.run(async (ctx) => {
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "unbind",
        schemaId,
      });
    });
    const orphaned = await t.query(api.bindings.list, {});
    expect(at(orphaned, 0).datasetExists).toBe(false);
    expect(at(orphaned, 0).datasetTitle).toBe("restaurantLocations");
  });

  it("getBySchema resolves the bound dataset and answers null for an ordinary one", async () => {
    const t = signedIn();
    const boundId = await bindSource(t);
    const ordinary = await t.mutation(api.schemas.create, {
      kind: "standard",
      schema: { fields: [], title: "Ordinary" },
    });
    const bound = await t.query(api.bindings.getBySchema, { schemaId: boundId });
    expect(bound === null ? undefined : bound.source).toBe("restaurantLocations");
    expect(await t.query(api.bindings.getBySchema, { schemaId: ordinary })).toBeNull();
  });

  it("history lists the sync/reconcile log newest first", async () => {
    const t = signedIn();
    await bindSource(t, 1);
    const status = await t.query(api.bindings.status, {});
    const binding = status === null ? undefined : status.binding;
    if (binding === undefined) {
      throw new Error("binding vanished");
    }
    await t.mutation(api.sync.startRun, { mode: "reconcile", source: "restaurantLocations" });
    await drainScheduled(t);
    const history = await t.query(api.bindings.history, { bindingId: binding._id });
    expect(history).toHaveLength(2);
    // Newest first: the reconcile (older sync sits behind it).
    expect(at(history, 0).kind).toBe("reconcile");
    expect(at(history, 1).kind).toBe("sync");
  });
});

describe("unbind", () => {
  it("removes the binding, dataset, activity, and key map — leaving the source tables and a re-sync path", async () => {
    const t = signedIn();
    const schemaId = await bindSource(t, 2);
    const binding = await requireBinding(t);
    await t.mutation(api.bindings.unbind, { schemaId });
    // The durable cleanup drains the related rows after the mutation
    // returns (#127 defect 10).
    await drainScheduled(t);

    expect(await t.query(api.bindings.list, {})).toStrictEqual([]);
    expect(await t.query(api.bindings.status, {})).toBeNull();
    expect(await t.query(api.bindings.getBySchema, { schemaId })).toBeNull();
    expect(await t.query(api.bindings.history, { bindingId: binding._id })).toStrictEqual([]);

    // The projected dataset is gone; the source tables are untouched.
    expect(await t.query(api.schemas.get, { schemaId })).toBeNull();
    const sourceRows = await t.run(async (ctx) => ({
      restaurants: await ctx.db.query("restaurants").collect(),
      locations: await ctx.db.query("locations").collect(),
      links: await ctx.db.query("restaurantLocations").collect(),
    }));
    expect(sourceRows.restaurants).toHaveLength(1);
    expect(sourceRows.locations).toHaveLength(2);
    expect(sourceRows.links).toHaveLength(2);

    // A later sync simply re-creates the projection under a NEW dataset id.
    await t.mutation(api.sync.startRun, { mode: "sync", source: "restaurantLocations" });
    await drainScheduled(t);
    const rebound = await t.query(api.bindings.status, {});
    expect(rebound === null ? undefined : rebound.binding.schemaId).not.toBe(schemaId);
    expect(rebound === null ? undefined : rebound.binding.syncedEntryCount).toBe(2);
  });

  it("refuses a dataset with no binding to remove", async () => {
    const t = signedIn();
    const ordinary = await t.mutation(api.schemas.create, {
      kind: "standard",
      schema: { fields: [], title: "Ordinary" },
    });
    await expect(t.mutation(api.bindings.unbind, { schemaId: ordinary })).rejects.toThrow(
      /no source binding to remove/,
    );
  });

  it("every other deletion path for a bound dataset stays blocked (the read-only gate)", async () => {
    const t = signedIn();
    const schemaId = await bindSource(t, 1);
    await expect(t.mutation(api.schemas.remove, { schemaId })).rejects.toThrow(/read-only/);
    // Writes to the projection are blocked the same way.
    await expect(
      t.mutation(api.entries.create, { data: { label: "X" }, schemaId }),
    ).rejects.toThrow(/read-only/);
    // The unbind attestation is what unlocks the delete — after unbind the
    // plain delete path works on ordinary datasets again.
  });
});

/** Narrowing helper (no optional chaining in assertions). */
async function requireBinding(t: TestConvex): Promise<Binding> {
  const status = await t.query(api.bindings.status, {});
  if (status === null) {
    throw new Error("no binding exists");
  }
  return status.binding;
}

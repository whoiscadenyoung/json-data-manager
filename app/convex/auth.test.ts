// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The sign-in gate (roadmap 0.1): every unauthenticated data call must fail,
 * every signed-in call must work and carry its identity. The surface splits
 * into three buckets (the filed issue's inventory):
 *
 * 1. exposeApi wrappers — gated by the `auth` hook inside the wrapper itself.
 * 2. Host functions that already called `auth(ctx)` for the read-only policy
 *    (schemas maintenance, tile archives) — gated by the same hook call.
 * 3. Host functions that had no hook — gated by an explicit `await
 *    auth(ctx)` added at the top of each handler.
 *
 * `users.me` is the one deliberate exception: it is the app's auth-state
 * probe and returns null signed out (documented on the function).
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { auth } from "./auth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const GATE_MESSAGE = /signed out/i;

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

/**
 * A minimal ctx for the unit tests of the gate itself — only the identity
 * surface `auth()` reads (convex's `Auth` is exactly `{ getUserIdentity }`).
 */
function fakeCtx(subject: string | null): Parameters<typeof auth>[0] {
  return {
    auth: {
      getUserIdentity: async () =>
        subject === null
          ? null
          : { issuer: "test", subject, tokenIdentifier: `test:${subject}` },
    },
  };
}

describe("auth (the gate itself)", () => {
  it("throws on a null identity", async () => {
    await expect(auth(fakeCtx(null))).rejects.toThrow(GATE_MESSAGE);
  });

  it("returns the identity subject when signed in", async () => {
    const subject = await auth(fakeCtx("user-1"));
    expect(subject).toBe("user-1");
  });
});

describe("gate: exposeApi wrappers (bucket 1)", () => {
  it("rejects a signed-out read (schemas.list)", async () => {
    const t = initTest();
    await expect(t.query(api.schemas.list, {})).rejects.toThrow(GATE_MESSAGE);
  });

  it("rejects a signed-out read (entries.listPage)", async () => {
    const t = initTest();
    await expect(
      t.query(api.entries.listPage, {
        paginationOpts: { cursor: null, numItems: 10 },
        schemaId: "irrelevant-the-gate-runs-first",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
  });

  it("rejects a signed-out write (entries.create)", async () => {
    const t = initTest();
    await expect(
      t.mutation(api.entries.create, { data: { name: "x" }, schemaId: "irrelevant" }),
    ).rejects.toThrow(GATE_MESSAGE);
  });

  it("signed-in writes work, read back, and stamp createdBy", async () => {
    const t = initTest().withIdentity({ subject: "user-1" });
    const schemaId = await t.mutation(api.schemas.create, {
      kind: "standard",
      schema: { fields: [], title: "Gate test" },
    });
    const doc = await t.query(api.schemas.get, { schemaId });
    if (doc === null) {
      throw new Error("created schema doc not found");
    }
    expect(doc.createdBy).toBe("user-1");
    const page = await t.query(api.entries.listPage, {
      paginationOpts: { cursor: null, numItems: 10 },
      schemaId,
    });
    expect(page.page).toStrictEqual([]);
  });
});

describe("gate: host functions already riding the hook (bucket 2)", () => {
  it("rejects maxTileCacheVersion signed out; returns 0 signed in", async () => {
    const t = initTest();
    await expect(t.query(api.schemas.maxTileCacheVersion, {})).rejects.toThrow(GATE_MESSAGE);
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    expect(await signedIn.query(api.schemas.maxTileCacheVersion, {})).toBe(0);
  });

  it("rejects tile archive metas signed out; returns [] signed in", async () => {
    const t = initTest();
    await expect(t.query(api.tile_archives.metas, { schemaIds: [] })).rejects.toThrow(
      GATE_MESSAGE,
    );
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    expect(await signedIn.query(api.tile_archives.metas, { schemaIds: [] })).toStrictEqual([]);
  });
});

describe("gate: host functions with an explicit gate (bucket 3)", () => {
  it("bindings: list rejects signed out, returns [] signed in; unbind rejects signed out", async () => {
    const t = initTest();
    await expect(t.query(api.bindings.list, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.mutation(api.bindings.unbind, { schemaId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    expect(await signedIn.query(api.bindings.list, {})).toStrictEqual([]);
  });

  it("tags: retentionSettings rejects signed out, defaults signed in; setKeepVersions and the ingest action reject signed out", async () => {
    const t = initTest();
    await expect(
      t.query(api.tags.retentionSettings, { sourceSchemaId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      t.mutation(api.tags.setKeepVersions, { keep: 3, sourceSchemaId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(t.action(api.tags.ingestSnapshots, {})).rejects.toThrow(GATE_MESSAGE);
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    expect(
      await signedIn.query(api.tags.retentionSettings, { sourceSchemaId: "x" }),
    ).toStrictEqual({ keepVersions: 10, pinnedRefs: [] });
  });

  it("sync: latestRun rejects signed out, returns null signed in; startRun rejects signed out", async () => {
    const t = initTest();
    await expect(t.query(api.sync.latestRun, { source: "x" })).rejects.toThrow(GATE_MESSAGE);
    await expect(
      t.mutation(api.sync.startRun, { mode: "sync", source: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    expect(await signedIn.query(api.sync.latestRun, { source: "x" })).toBeNull();
  });

  it("dashboard: reads and writes reject signed out; a signed-in write reads back", async () => {
    const t = initTest();
    await expect(t.query(api.dashboard.listRestaurants, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(
      t.mutation(api.dashboard.createRestaurant, { cuisine: "Cafe", name: "Gate" }),
    ).rejects.toThrow(GATE_MESSAGE);
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    const id = await signedIn.mutation(api.dashboard.createRestaurant, {
      cuisine: "Cafe",
      name: "Gate",
    });
    expect(id).toBeTruthy();
    const rows = await signedIn.query(api.dashboard.listRestaurants, {});
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row === undefined ? undefined : row.name).toBe("Gate");
  });

  it("users: listProfiles and profileByAuthId reject signed out; resolve signed in", async () => {
    const t = initTest();
    await expect(t.query(api.users.listProfiles, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.users.profileByAuthId, { authId: "user-1" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    const signedIn = initTest().withIdentity({ subject: "user-1" });
    await signedIn.run(async (ctx) => {
      await ctx.db.insert("users", {
        authId: "user-1",
        email: "user-1@example.com",
        emailVerified: true,
        name: "User One",
      });
    });
    const profile = await signedIn.query(api.users.profileByAuthId, { authId: "user-1" });
    expect(profile === null ? undefined : profile.name).toBe("User One");
    expect(await signedIn.query(api.users.listProfiles, {})).toHaveLength(1);
  });

  it("users.me stays callable signed out and returns null (the deliberate exception)", async () => {
    const t = initTest();
    expect(await t.query(api.users.me, {})).toBeNull();
  });
});

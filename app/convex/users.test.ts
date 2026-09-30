// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The user-profile mirror reads (users.ts) — behavioral coverage beyond the
 * sign-in gate (issue #138). Rows in the `users` table are the app-side
 * mirror of Better Auth users, maintained exclusively by auth.ts's triggers
 * — tests insert mirror rows directly (the auth.test.ts precedent).
 *
 * Not exercisable here: `users.me` for a SIGNED-IN caller. It resolves
 * through the Better Auth component (`safeGetAuthUser`), and convex-test
 * has no mount for that component in this repo's setup (the component's
 * module tree is never registered), so a signed-in call cannot run — the
 * gate suite (auth.test.ts) covers only the signed-out probe for the same
 * reason. The mirror-row reads below carry the identity surfaces that CAN
 * run.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

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

function signedIn(subject = "user-1") {
  return initTest().withIdentity({ subject });
}

type TestConvex = ReturnType<typeof signedIn>;

const GATE = /signed out/i;

/** A mirror row exactly as auth.ts's triggers write them. */
async function insertMirrorUser(
  t: TestConvex,
  user: { authId: string; email: string; image?: string; name?: string },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      authId: user.authId,
      email: user.email,
      emailVerified: true,
      image: user.image,
      name: user.name,
    });
  });
}

describe("me (the auth-state probe)", () => {
  it("answers null signed out — the one deliberate exception to the gate", async () => {
    const t = initTest();
    expect(await t.query(api.users.me, {})).toBeNull();
  });
});

describe("profileByAuthId", () => {
  it("resolves a mirror row for any signed-in viewer and answers null for an unknown id", async () => {
    const t = signedIn();
    await insertMirrorUser(t, {
      authId: "user-2",
      email: "two@example.com",
      image: "https://example.com/a.png",
      name: "User Two",
    });
    const profile = await t.query(api.users.profileByAuthId, { authId: "user-2" });
    expect(profile === null ? undefined : profile.name).toBe("User Two");
    expect(profile === null ? undefined : profile.image).toBe("https://example.com/a.png");
    // Another user's id resolves the same way — the display side of the
    // component's createdBy stamping.
    const other = t.withIdentity({ subject: "user-3" });
    const foreign = await other.query(api.users.profileByAuthId, { authId: "user-2" });
    expect(foreign === null ? undefined : foreign.email).toBe("two@example.com");
    expect(await t.query(api.users.profileByAuthId, { authId: "nobody" })).toBeNull();
  });

  it("rejects a signed-out caller", async () => {
    const t = initTest();
    await expect(t.query(api.users.profileByAuthId, { authId: "user-2" })).rejects.toThrow(GATE);
  });
});

describe("profile (one page load)", () => {
  it("returns the mirror row plus the profiled user's datasets, scoped by the viewer", async () => {
    const t = signedIn("user-1");
    await insertMirrorUser(t, { authId: "user-1", email: "one@example.com", name: "User One" });
    await insertMirrorUser(t, { authId: "user-2", email: "two@example.com", name: "User Two" });

    // Each user creates a public dataset (createdBy = its caller).
    const mine = await t.mutation(api.schemas.create, {
      kind: "standard",
      schema: { fields: [], title: "Mine" },
    });
    const theirs = await t
      .withIdentity({ subject: "user-2" })
      .mutation(api.schemas.create, { kind: "standard", schema: { fields: [], title: "Theirs" } });

    // User One's profile, viewed by user-2: public rows are catalog-visible
    // to every signed-in collaborator (ADR 0009), filtered to the profiled
    // creator only.
    const asOther = t.withIdentity({ subject: "user-2" });
    const one = await asOther.query(api.users.profile, { authId: "user-1" });
    expect(one.user === null ? undefined : one.user.name).toBe("User One");
    expect(one.datasets.map((dataset) => dataset._id)).toContain(mine);
    expect(one.datasets).toHaveLength(1);

    const two = await t.query(api.users.profile, { authId: "user-2" });
    expect(two.datasets.map((dataset) => dataset._id)).toContain(theirs);

    // An unknown id renders the page's not-found state: user null, no
    // datasets can match.
    const missing = await t.query(api.users.profile, { authId: "ghost" });
    expect(missing.user).toBeNull();
    expect(missing.datasets).toStrictEqual([]);
  });

  it("never lists drafts, and an author-restricted published row appears only to its author", async () => {
    const t = signedIn("user-1");
    await insertMirrorUser(t, { authId: "user-1", email: "one@example.com", name: "User One" });
    // A draft (invisible to every viewer's profile) and an author-narrowed
    // published row (component-host-flow fields the wrapper omits).
    const draft = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        actorId: "user-1",
        lifecycle: "draft",
        schema: { fields: [], title: "Secret draft" },
      }),
    );
    const narrowed = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        actorId: "user-1",
        publishedVisibility: "author",
        schema: { fields: [], title: "Authors only" },
      }),
    );
    // The author sees their narrowed row but never the draft.
    const mine = await t.query(api.users.profile, { authId: "user-1" });
    const mineIds = mine.datasets.map((dataset) => dataset._id);
    expect(mineIds).toContain(narrowed);
    expect(mineIds).not.toContain(draft);

    // Another viewer gets neither.
    const other = t.withIdentity({ subject: "user-2" });
    const foreign = await other.query(api.users.profile, { authId: "user-1" });
    const foreignIds = foreign.datasets.map((dataset) => dataset._id);
    expect(foreignIds).not.toContain(narrowed);
    expect(foreignIds).not.toContain(draft);
    expect(foreign.datasets).toStrictEqual([]);
  });
});

describe("listProfiles (the authId → name map)", () => {
  it("lists every user's display surface WITHOUT the email (the PII rule)", async () => {
    const t = signedIn();
    await insertMirrorUser(t, {
      authId: "user-1",
      email: "one@example.com",
      image: "https://example.com/1.png",
      name: "User One",
    });
    await insertMirrorUser(t, { authId: "user-2", email: "two@example.com", name: "User Two" });
    const profiles = await t.query(api.users.listProfiles, {});
    // Convex strips undefined fields — a user without an image has no key.
    expect(profiles).toStrictEqual([
      { authId: "user-1", image: "https://example.com/1.png", name: "User One" },
      { authId: "user-2", name: "User Two" },
    ]);
    // The email never rides the broadest surface: only the three display
    // keys may appear.
    for (const profile of profiles) {
      for (const key of Object.keys(profile)) {
        expect(["authId", "image", "name"]).toContain(key);
      }
    }
  });

  it("rejects a signed-out caller", async () => {
    const t = initTest();
    await expect(t.query(api.users.listProfiles, {})).rejects.toThrow(GATE);
  });
});

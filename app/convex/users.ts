import { v } from "convex/values";

import { components } from "./_generated/api";
import { query } from "./_generated/server";
import { auth, authComponent } from "./auth";

/**
 * The signed-in viewer's app profile row (the `users` mirror of the Better
 * Auth user), or null when signed out. Everything the header/user surfaces
 * need rides on the mirror — this stays one indexed read past identity.
 *
 * The one deliberate exception to the sign-in gate (roadmap 0.1): this query
 * IS the app's auth-state probe — the header renders "Sign in" from its
 * signed-out null, so it must stay callable unauthenticated. It discloses
 * nothing: signed out it returns null, signed in only the caller's own row.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const authUser = await authComponent.safeGetAuthUser(ctx);
    if (authUser === undefined) {
      return null;
    }
    return ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser._id))
      .first();
  },
});

/**
 * Resolve any Better Auth user id to its app profile — the display side of
 * the component's `createdBy` stamping (dataset overview shows who created
 * a dataset). null when the id has no mirror row (deleted user, or a
 * system/foreign actor the host's auth hook invented).
 */
export const profileByAuthId = query({
  args: { authId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    return ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
  },
});

/**
 * One profile page load: the user's mirror row plus the datasets they've
 * created, newest first. `authId` here is the Better Auth user id — the same
 * string the component stamps as `schemas.createdBy`, so every "Created by"
 * surface can deep-link here without an extra resolution hop. `user` is null
 * when the id has no mirror row (deleted user or a system actor) — the page
 * renders a not-found state.
 *
 * Creator filtering happens host-side over the component's summaries
 * projection (the same light read the datasets browser already pays on every
 * load) — the component's table is host-only, and dataset counts are far
 * below anything that would want a component-side creator query. No `returns`
 * validator: it would have to re-declare the component's whole summary shape.
 */
export const profile = query({
  args: { authId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
    const summaries = await ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {});
    return {
      datasets: summaries.filter((summary) => summary.createdBy === args.authId),
      user,
    };
  },
});

/**
 * Every user's display surface — authId, name, image — for building
 * authId → name maps on list pages (the datasets browser's "by X" lines).
 * Deliberately omits the email: the broadest surface gets the least PII,
 * and names (falling back to nothing) are all a card needs. The dataset
 * overview keeps using profileByAuthId, which does resolve email.
 */
export const listProfiles = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const rows = await ctx.db.query("users").collect();
    return rows.map((row) => ({ authId: row.authId, image: row.image, name: row.name }));
  },
  returns: v.array(
    v.object({
      authId: v.string(),
      image: v.optional(v.string()),
      name: v.optional(v.string()),
    }),
  ),
});

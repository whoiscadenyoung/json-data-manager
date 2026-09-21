import { query } from "./_generated/server";
import { v } from "convex/values";

import { authComponent } from "./auth";

/**
 * The signed-in viewer's app profile row (the `users` mirror of the Better
 * Auth user), or null when signed out. Everything the header/user surfaces
 * need rides on the mirror — this stays one indexed read past identity.
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
  handler: async (ctx, args) =>
    ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first(),
});

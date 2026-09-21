import { query } from "./_generated/server";

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

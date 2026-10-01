import { v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { auth, authComponent } from "./auth";

/**
 * The public profile projection — everything one signed-in collaborator may
 * learn about another: the listProfiles display fields plus the row's
 * creation time (the profile page's "Joined" line). The email is
 * deliberately absent (issue #136, ADR 0009 addendum): profiles are
 * co-browsable by design under the trusted-collaborator model, and the
 * broadest surfaces get the least PII — a collaborator's email is theirs to
 * share, not something every other signed-in user resolves. It rides only
 * `selfProfile`, which a viewer gets back exclusively about themself.
 */
const publicProfile = v.object({
  _creationTime: v.number(),
  authId: v.string(),
  image: v.optional(v.string()),
  name: v.optional(v.string()),
});

/** `publicProfile` plus the email — the shape only the user themself reads. */
const selfProfile = publicProfile.extend({ email: v.string() });

/**
 * The projection a mirror row resolves to: the public shape, with the email
 * added only when the viewer IS that user.
 */
function profileProjection(row: Doc<"users">, viewerId: string) {
  if (row.authId === viewerId) {
    return {
      _creationTime: row._creationTime,
      authId: row.authId,
      email: row.email,
      image: row.image,
      name: row.name,
    };
  }
  return {
    _creationTime: row._creationTime,
    authId: row.authId,
    image: row.image,
    name: row.name,
  };
}

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
 * a dataset). The result is the public projection (no email — see
 * `publicProfile` above) unless the viewer IS that user, the one case where
 * the email rides along. null when the id has no mirror row (deleted user,
 * or a system/foreign actor the host's auth hook invented).
 */
export const profileByAuthId = query({
  args: { authId: v.string() },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    const row = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
    if (row === null) {
      return null;
    }
    return profileProjection(row, viewerId);
  },
  returns: v.union(v.null(), publicProfile, selfProfile),
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
 * below anything that would want a component-side creator query. `user` is
 * the public projection (`publicProfile` above) — no email — unless the
 * viewer is the profiled user themself, the one case where the page shows
 * the email back. No `returns` validator: it would have to re-declare the
 * component's whole summary shape.
 */
export const profile = query({
  args: { authId: v.string() },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    const row = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
    // The viewer's identity scopes the component read (stage 8, #104): a
    // profiled user's author-restricted published datasets appear only to
    // that user; drafts never appear in any viewer's profile either way (the
    // summaries projection excludes them).
    const summaries = await ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {
      viewerId,
    });
    return {
      datasets: summaries.filter((summary) => summary.createdBy === args.authId),
      user: row === null ? null : profileProjection(row, viewerId),
    };
  },
});

/**
 * Every user's display surface — authId, name, image — for building
 * authId → name maps on list pages (the datasets browser's "by X" lines).
 * Deliberately omits the email: the broadest surface gets the least PII,
 * and names (falling back to nothing) are all a card needs. Since #136 the
 * by-id resolvers (`profileByAuthId`/`profile`) share this rule — the email
 * comes back only when the viewer is that user — so no profile surface
 * leaks it anymore.
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

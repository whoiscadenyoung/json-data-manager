import { createClient, type AuthFunctions, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import type { ExposeApiOperation } from "@caden/json-cms";
import type { Auth } from "convex/server";
import { ConvexError } from "convex/values";

import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

import authConfig from "./auth.config";

/**
 * The app origin. Better Auth's `baseURL` and trusted origin — cookies are
 * issued for this origin and the Start server proxies auth requests to the
 * component from here, so the deployment never sees another value in dev.
 */
const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";

// The explicit annotation matters: these are auth.ts's own exports (via
// triggersApi below), so an inline literal in the config would make
// authComponent's type self-referential and collapse it to any.
const authFunctions: AuthFunctions = {
  onCreate: internal.auth.onCreate,
  onUpdate: internal.auth.onUpdate,
  onDelete: internal.auth.onDelete,
};

/**
 * Better Auth, running inside Convex through the @convex-dev/better-auth
 * component ("hybrid" mode): the auth API executes in component HTTP routes
 * (registered in http.ts, proxied same-origin via src/routes/api/auth/$.tsx)
 * and Better Auth's own tables (user/session/account/verification/jwks) live
 * namespaced inside the component — this schema only holds the app-side
 * mirror. The `users` table is that mirror: the triggers below create,
 * update and delete one row per Better Auth user, keyed by `authId` (the
 * Better Auth user id, which is the component's `user._id`).
 */
export const authComponent = createClient<DataModel>(components.betterAuth, {
  triggers: {
    user: {
      onCreate: async (ctx, user) => {
        await insertAppUser(ctx, user._id, user);
      },
      onDelete: async (ctx, user) => {
        const row = await appUserForAuthId(ctx, user._id);
        if (row !== null) {
          await ctx.db.delete(row._id);
        }
      },
      onUpdate: async (ctx, user) => {
        const row = await appUserForAuthId(ctx, user._id);
        if (row === null) {
          await insertAppUser(ctx, user._id, user);
          return;
        }
        await ctx.db.patch(row._id, appUserFields(user));
      },
    },
  },
  // The component calls these app-side mutations whenever Better Auth
  // writes a user; triggersApi() below is their implementation.
  authFunctions,
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

/**
 * Build the Better Auth instance bound to this call's context. Cheap enough
 * to call per function invocation (the component caches internally); used by
 * http.ts for the route handlers and by authComponent.getAuth for direct
 * Better Auth API calls from Convex functions.
 */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true },
    plugins: [convex({ authConfig })],
    trustedOrigins: [siteUrl],
  });
};

type BetterAuthUser = {
  email: string;
  emailVerified: boolean;
  image?: string | null;
  name: string;
};

function appUserFields(user: BetterAuthUser) {
  return {
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image ?? undefined,
    name: user.name,
  };
}

async function insertAppUser(ctx: MutationCtx, authId: string, user: BetterAuthUser) {
  await ctx.db.insert("users", { authId, ...appUserFields(user) });
}

async function appUserForAuthId(ctx: MutationCtx, authId: string) {
  return ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .first();
}

/**
 * The app's identity gate (the one choke point every exposeApi-wrapped
 * mutation flows through) plus the app-side half of the bound-datasets
 * read-only gate: writes targeting a read-only dataset are rejected here.
 * Two kinds of dataset are read-only: a live projection with a
 * `datasetBindings` row (a synced external source) and a frozen tag version
 * (`lineage` on the component's schema doc). The sync and tag ingest call the
 * component directly (not through exposeApi), so both are unaffected.
 *
 * Allowed on read-only datasets: schema metadata edits (`updateSchema`) and
 * organization (collection/group membership) — the data is read-only, not the
 * filing. Deletion is blocked too: removing a bound dataset goes through the
 * explicit unbind flow (`bindings.unbind`), and version datasets retire via
 * `tags.retireVersion` — both call the component directly with the host-only
 * `boundWrite` attestation.
 *
 * Since #75, enforcement no longer depends on this choke point: the
 * component itself rejects data mutations on `source`/`lineage`-marked
 * schemas unless the caller carries the `boundWrite` attestation
 * (`assertDataWritable` in the component), which no exposeApi wrapper can
 * carry — that closes `startSimplification`/`startGeospatialConversion` too,
 * whose `{schemaId, "update"}` shape was indistinguishable from organization
 * ops here. This gate stays as the user-facing first line (friendlier error,
 * one fewer round trip) and for the paths only it can see.
 *
 * Authentication itself now rides on Better Auth (above): callers receive
 * the signed-in Better Auth user id as the identity string, falling back to
 * "anonymous" for unauthenticated callers. Nothing requires sign-in yet —
 * the app's reads and writes still work signed out; gating is a separate
 * decision layered on top of this return value.
 */
export async function auth(
  ctx: { auth: Auth },
  operation?: ExposeApiOperation,
): Promise<string> {
  if (operation !== undefined && operation.type !== "read") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every caller passes a full MutationCtx; the narrow `{ auth }` param keeps the read path callable from http actions.
    const mutationCtx = ctx as MutationCtx;
    let schemaId = operation.schemaId;
    if (schemaId === undefined && operation.entryId !== undefined) {
      schemaId = await entrySchemaId(mutationCtx, operation.entryId);
    }
    // Entry-targeted writes always touch data. Schema-targeted creates are
    // data operations (entries, imports); schema-targeted deletes are data
    // operations or dataset deletion (both gated); schema-targeted updates
    // are metadata/organization and stay allowed.
    if (
      schemaId !== undefined &&
      (operation.entryId !== undefined || operation.type !== "update") &&
      (await isReadOnlyDataset(mutationCtx, schemaId))
    ) {
      throw new ConvexError(
        "This dataset is synced from a connected source and is read-only here — edit the source data and re-sync instead.",
      );
    }
  }
  // The Better Auth session token's subject is the Better Auth user id —
  // the same value `users.authId` holds. Unauthenticated callers (the norm
  // today) keep the historical constant.
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return "anonymous";
  }
  return identity.subject;
}

async function isReadOnlyDataset(ctx: MutationCtx, schemaId: string): Promise<boolean> {
  // `.first()` resolves to NULL when nothing matches — `!== undefined` was
  // always true, which gated every dataset (all entry writes rejected) as
  // soon as the bindings feature deployed. Found while setting up the
  // #71 two-tab rebuild drive.
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
    .first();
  if (binding !== null) {
    return true;
  }
  // A frozen tag version has no binding row of its own — its lineage marks
  // it read-only the same way. Only the datasets that fail the binding
  // check pay this extra component read.
  const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  return schema !== null && schema.lineage !== undefined;
}

async function entrySchemaId(ctx: MutationCtx, entryId: string): Promise<string | undefined> {
  const entry = await ctx.runQuery(components.jsonCms.lib.getEntry, { entryId });
  if (entry === null) {
    return undefined;
  }
  return entry.schemaId;
}

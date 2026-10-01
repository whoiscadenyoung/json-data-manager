import type { ExposeApiOperation } from "@caden/json-cms";
import { createClient, type AuthFunctions, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import type { Auth, FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import authConfig from "./auth.config";

/**
 * The localhost fallback for local dev — the only place a missing SITE_URL
 * is allowed to default (issue #136): on any real deployment the app origin
 * must be configured explicitly, so cookies and trusted origins are never
 * quietly issued for localhost in production.
 */
const LOCAL_SITE_URL = "http://localhost:3000";

/**
 * Resolve the app origin, failing closed (issue #136): SITE_URL must be set
 * on a non-dev deployment — the module-level `siteUrl` below throws at init
 * otherwise, so the deployment's functions never boot with Better Auth
 * pointed at the wrong origin. The localhost fallback survives only for
 * local dev: no `CONVEX_DEPLOYMENT` at all (the test runner, one-off
 * scripts), a `local-…` backend (the local-backend recipe, which names its
 * deployment without a cloud kind prefix), or a cloud `dev:` deployment.
 * Everything else — `prod:`, `preview:`, any unknown kind — is real and
 * throws.
 */
export function resolveSiteUrl(siteUrl: string | undefined, deployment: string | undefined) {
  if (siteUrl !== undefined && siteUrl !== "") {
    return siteUrl;
  }
  const isLocalDev =
    deployment === undefined || deployment.startsWith("dev:") || !deployment.includes(":");
  if (!isLocalDev) {
    throw new Error(
      `SITE_URL is not set on deployment "${deployment}". Set it to the origin the app is served from (bunx convex env set SITE_URL https://…): Better Auth issues session cookies and accepts origins only for this URL, so it must be configured explicitly outside local dev.`,
    );
  }
  return LOCAL_SITE_URL;
}

/**
 * The app origin. Better Auth's `baseURL` and trusted origin — cookies are
 * issued for this origin and the Start server proxies auth requests to the
 * component from here, so the deployment never sees another value in dev.
 * Throws at init when unset on a non-dev deployment (resolveSiteUrl above).
 */
export const siteUrl = resolveSiteUrl(process.env.SITE_URL, process.env.CONVEX_DEPLOYMENT);

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
 *
 * Signup policy (issue #136, ADR 0009 addendum — option (a)): the trust
 * model holds only if who can sign in is controlled, so the PUBLIC surface
 * ships with `disableSignUp: true` — no self-serve registration; the
 * sign-in endpoint is unaffected. The one way in is `createAccount` below,
 * an internal mutation, so only host code (or an operator via `convex run`
 * with the admin key) can mint accounts. `allowSignUp` exists solely for
 * that path — every HTTP-driven caller of this builder gets the locked
 * config.
 */
export const createAuth = (ctx: GenericCtx<DataModel>, options?: { allowSignUp?: boolean }) => {
  // Signup stays closed unless the host-side creation path asks for it open.
  const allowSignUp = options !== undefined && options.allowSignUp === true;
  return betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
    },
    plugins: [convex({ authConfig })],
    trustedOrigins: [siteUrl],
  });
};

/**
 * The host-side account-creation path (issue #136): the ONLY way a new user
 * comes into existence now that the public surface has
 * `emailAndPassword.disableSignUp`. Internal, so callers are host code and
 * operators with the deployment admin key — nobody can invoke it from a
 * browser or client SDK. It drives Better Auth's own sign-up endpoint
 * (password hashing, credential account linking, and the user trigger that
 * inserts the `users` mirror row) with the one flag flipped, rather than
 * Better Auth's admin API: the admin plugin adds `role`/`banned` fields
 * whose columns the better-auth component's schema lacks (ADR 0009
 * addendum).
 *
 * The operator recipe (also the local-dev first-account flow) lives in the
 * ADR: bunx convex run auth:createAccount '{"email": …, "password": …,
 * "name": …}' (local backend: add --url http://127.0.0.1:3212 --admin-key …).
 * Password must meet Better Auth's minimum (8 characters).
 */
export const createAccount = internalMutation({
  args: {
    email: v.string(),
    image: v.optional(v.string()),
    name: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const authInstance = createAuth(ctx, { allowSignUp: true });
    const created = await authInstance.api.signUpEmail({
      body: {
        email: args.email,
        image: args.image,
        name: args.name,
        password: args.password,
      },
    });
    // autoSignIn hands back a session token too — the operator's caller is
    // not a browser; only the created identity matters here.
    return { authId: created.user.id };
  },
  returns: v.object({ authId: v.string() }),
});

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
 * call flows through), the sharing/isolation policy (roadmap stage 8,
 * #104), and the app-side half of the bound-datasets read-only gate: writes
 * targeting a read-only dataset are rejected here.
 *
 * Identity (roadmap 0.1): callers receive the signed-in Better Auth user id
 * as the identity string, and unauthenticated callers are rejected here —
 * this one throw gates every exposeApi wrapper (read and write) plus every
 * host function that calls `await auth(ctx)`, with no parallel authz
 * mechanism.
 *
 * Isolation (stage 8, the recorded D1/D2 decisions on #104): a dataset that
 * is a DRAFT, or a catalog-visible row flagged `publishedVisibility:
 * "author"`, is readable and writable only by its creator (`createdBy` —
 * the same identity string). Every operation that names a dataset — by
 * schemaId, by entryId, or by an import id — is resolved here and
 * refused for anyone else, so the enumeration-level filters in the
 * component's catalog reads are matched by the by-id surfaces (the pre-
 * stage-8 by-id leak). The denial is deliberately indistinguishable from
 * "not found" so an id's existence never leaks; enumeration reads never
 * reach this check (they carry no ids) and are scoped inside the component
 * via the `viewerId` the wrappers pass.
 *
 * The bound-datasets read-only gate: two kinds of dataset are read-only — a
 * live projection with a `datasetBindings` row (a synced external source)
 * and a frozen tag version (`lineage` on the component's schema doc). The
 * sync and tag ingest call the component directly (not through exposeApi),
 * so both are unaffected.
 *
 * Allowed on read-only datasets: schema metadata edits (`updateSchema`) and
 * organization (collection/group membership) — the data is read-only, not
 * the filing. Deletion is blocked too: removing a bound dataset goes through
 * the explicit unbind flow (`bindings.unbind`), and version datasets retire
 * via `tags.retireVersion` — both call the component directly with the
 * host-only `boundWrite` attestation.
 *
 * Since #75, enforcement no longer depends on this choke point: the
 * component itself rejects data mutations on `source`/`lineage`-marked
 * schemas unless the caller carries the `boundWrite` attestation
 * (`assertDataWritable` in the component), which no exposeApi wrapper can
 * carry — that closes `startSimplification`/`startGeospatialConversion` too,
 * whose `{schemaId, "update"}` shape was indistinguishable from organization
 * ops here. This gate stays as the user-facing first line (friendlier error,
 * one fewer round trip) and for the paths only it can see. The isolation
 * check above runs FIRST so a caller learns nothing — not even a dataset's
 * read-only-ness — about rows they cannot see.
 *
 * The edit-policy gate (issue #124, ADR 0010): a dataset flagged
 * `editPolicy: "locked"` answers EVERY write — data, schema, and the
 * organization ops the read-only gate above deliberately allows — to its
 * `createdBy` alone; `"open"` (and absent, so every pre-field row) keeps the
 * trusted-collaborator co-editable default (ADR 0009) and is refused
 * nowhere. The check runs after the visibility check (an invisible row still
 * reads as "not found", never as "locked") and before the read-only gate
 * (frozen/bound datasets stay read-only whatever the policy is — the policy
 * adds a restriction, never removes one). Reads are untouched:
 * `publishedVisibility` decides who may see a dataset, `editPolicy` decides
 * who may change it. Host flows that bypass the wrappers
 * (`bindings.unbind`, `bundles.recordMember`/`promoteCollection`) call
 * `assertDatasetWritable` explicitly; `tile_archives.install` rides the
 * choke point through its `{fn, schemaId, "update"}` operation, and the tag
 * path's creator rules (`tags.retireVersion`,
 * `assertChainAnchorWritable`) already answer only to the creator for every
 * row a policy could lock.
 */
export async function auth(ctx: { auth: Auth }, operation?: ExposeApiOperation): Promise<string> {
  // The Better Auth session token's subject is the Better Auth user id —
  // the same value `users.authId` holds.
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("You're signed out — sign in to continue.");
  }
  if (operation !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every caller passes a full MutationCtx; the narrow `{ auth }` param keeps the read path callable from http actions.
    const mutationCtx = ctx as MutationCtx;
    await assertDatasetsVisible(mutationCtx, identity.subject, operation);
    if (operation.type !== "read") {
      await assertDatasetsWritable(mutationCtx, identity.subject, operation);
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
  }
  return identity.subject;
}

/**
 * One component schema read that tolerates an id that isn't well-formed
 * (the publish.ts precedent — the isolation check must never be the thing
 * that crashes a call; the underlying component read answers "not found"
 * for junk ids anyway).
 */
async function tryGetSchemaForPolicy(
  ctx: MutationCtx,
  schemaId: string,
): Promise<FunctionReturnType<typeof components.jsonCms.lib.getSchema>> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  } catch {
    return null;
  }
}

/**
 * Every dataset id one operation names — by schemaId, through an entryId, or
 * an import id (the component's one-read resolver). The BATCH id lists
 * (`listEntriesForIds`' entryIds, `listEntriesForSchemas`' schemaIds) are
 * deliberately NOT resolved here: denying a whole batch read on one invisible
 * id would crash the caller's form/reference panel for a stale reference —
 * those reads filter component-side by the wrapper's `viewerId` instead, so
 * an invisible target contributes no rows and no denial (stage 8, #104).
 * Split from the visibility check below so each helper reads as one concern.
 */
async function datasetIdsForOperation(
  ctx: MutationCtx,
  operation: ExposeApiOperation,
): Promise<Set<string>> {
  const schemaIds = new Set<string>();
  if (operation.schemaId !== undefined) {
    schemaIds.add(operation.schemaId);
  }
  if (operation.entryId !== undefined) {
    const schemaId = await entrySchemaId(ctx, operation.entryId);
    if (schemaId !== undefined) {
      schemaIds.add(schemaId);
    }
  }
  if (operation.importId !== undefined) {
    const schemaId = await ctx.runQuery(components.jsonCms.lib.getImportSchemaId, {
      importId: operation.importId,
    });
    if (schemaId !== null) {
      schemaIds.add(schemaId);
    }
  }
  return schemaIds;
}

/**
 * The stage-8 isolation policy itself: every dataset the operation names
 * must be visible to the caller — a draft or `publishedVisibility: "author"`
 * row only to its creator. Denials are indistinguishable from a missing
 * dataset (the same friendly message `getSchema`'s callers see for unknown
 * ids), so probing ids discloses nothing.
 */
async function assertDatasetsVisible(
  ctx: MutationCtx,
  actorId: string,
  operation: ExposeApiOperation,
): Promise<void> {
  await Promise.all(
    [...(await datasetIdsForOperation(ctx, operation))].map(async (schemaId) => {
      const doc = await tryGetSchemaForPolicy(ctx, schemaId);
      if (
        doc !== null &&
        (doc.lifecycle === "draft" || doc.publishedVisibility === "author") &&
        doc.createdBy !== actorId
      ) {
        throw new ConvexError("That dataset doesn't exist or you don't have access to it.");
      }
    }),
  );
}

/**
 * The one edit-policy denial (issue #124, ADR 0010), shared by the choke
 * point's operation loop and the host flows that bypass the wrappers. A
 * `"locked"` dataset answers every write to its creator alone; `"open"` —
 * and absent, so every pre-field row — is refused for nobody. The message
 * keeps today's denial shapes: a plain read-only-shaped `ConvexError`
 * (visibility is checked first by every caller, so an invisible row still
 * reads as "not found", and existence is public for published rows, so a
 * lock denial leaks nothing).
 */
export async function assertDatasetWritable(
  ctx: MutationCtx,
  actorId: string,
  schemaId: string,
): Promise<void> {
  const doc = await tryGetSchemaForPolicy(ctx, schemaId);
  if (doc !== null && doc.editPolicy === "locked" && doc.createdBy !== actorId) {
    throw new ConvexError(
      "This dataset is locked by its creator — only they can make changes to it.",
    );
  }
}

/**
 * The edit-policy gate over one write operation (issue #124): every dataset
 * the operation names — the same resolution the visibility check uses — must
 * be open for the caller to write. Runs for EVERY write `type`: on a locked
 * dataset the creator-only rule covers data writes, schema writes, and the
 * organization ops the read-only gate below deliberately allows, with no
 * carve-outs. Only the creator (and later, per ADR 0010, team admins) passes.
 */
async function assertDatasetsWritable(
  ctx: MutationCtx,
  actorId: string,
  operation: ExposeApiOperation,
): Promise<void> {
  await Promise.all(
    [...(await datasetIdsForOperation(ctx, operation))].map(async (schemaId) => {
      await assertDatasetWritable(ctx, actorId, schemaId);
    }),
  );
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

/**
 * The dataset an entry id names, or undefined when the entry is gone or the
 * id isn't well-formed (tolerant on purpose: the isolation check must never
 * be what crashes a call — the component's own read answers "not found" for
 * junk ids).
 */
async function entrySchemaId(ctx: MutationCtx, entryId: string): Promise<string | undefined> {
  try {
    const entry = await ctx.runQuery(components.jsonCms.lib.getEntry, { entryId });
    if (entry === null) {
      return undefined;
    }
    return entry.schemaId;
  } catch {
    return undefined;
  }
}

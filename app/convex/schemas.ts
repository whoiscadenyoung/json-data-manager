import { exposeApi } from "@caden/json-cms";
import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { auth } from "./auth";

export const {
  listSchemas: list,
  listSchemaSummaries: listSummaries,
  // The opt-in drafts view (roadmap 5a, #99): `listSummaries` filters drafts
  // server-side, so this is the only host read that returns them — the
  // datasets browser's drafts toggle subscribes to it. Since stage 8 (#104)
  // the drafts come back creator-scoped (the choke point's identity rides
  // the wrapper as `viewerId`): user B's toggle never lists user A's drafts.
  listDraftSchemaSummaries: listDraftSummaries,
  getSchema: get,
  getSourceFileUrl,
  createSchema: create,
  updateSchema: update,
  deleteSchema: remove,
} = exposeApi(components.jsonCms, { auth });

/**
 * The largest `mapTileCacheVersion` across all datasets — the cache-buster for
 * the client's persisted light-state cache (issue #58 part 5). Any
 * geometry-affecting write bumps some dataset's version (part 2), so this one
 * number changes exactly when persisted client state may be stale: a mismatch
 * against the persisted buster discards it, while unchanged datasets (the
 * common case) keep their persisted instant-open.
 *
 * Runs the fold server-side so the client pays one number over the wire, not
 * every schema row — over the summaries projection (issue #53), so the
 * component→host hop doesn't carry `schema`/`uiSchema` payloads either.
 *
 * Drafts (roadmap 5a, #99) are excluded: they ride the draft-filtered
 * `listSchemaSummaries`, which is correct while they're invisible (nothing
 * persisted renders a draft). When 5b's publish births a published version
 * row (the draft itself is never flipped), that row's archive version enters
 * this fold and the buster changes once — exactly when the dataset becomes
 * consumer-visible, which is when stale persisted state must be discarded.
 */
export const maxTileCacheVersion = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await auth(ctx);
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, { viewerId });
    let max = 0;
    for (const schema of schemas) {
      max = Math.max(max, schema.mapTileCacheVersion ?? 0);
    }
    return max;
  },
  returns: v.number(),
});

/**
 * The creator's published-visibility control (stage 8, #104 — decision D2 on
 * the issue): "author" narrows every catalog read of this dataset to its
 * creator, "everyone" restores the default. Creator-only, enforced HERE —
 * the component's `setSchemaVisibility` is deliberately unexposed, so this
 * host mutation is the only writer (the `lifecycle`/`boundWrite` pattern:
 * host flows resolve identity at the choke point, component flows stay
 * identity-less). Denials read as "not found" so an id's existence never
 * leaks.
 */
export const setVisibility = mutation({
  args: {
    schemaId: v.string(),
    visibility: v.union(v.literal("author"), v.literal("everyone")),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    let doc: FunctionReturnType<typeof components.jsonCms.lib.getSchema>;
    try {
      doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: args.schemaId });
    } catch {
      // A string that isn't a well-formed component id — the same "not
      // found" as an unknown id (the projects.ts tryGetSchema precedent).
      doc = null;
    }
    if (doc === null || doc.createdBy !== actorId) {
      throw new ConvexError("That dataset doesn't exist or you don't have access to it.");
    }
    await ctx.runMutation(components.jsonCms.lib.setSchemaVisibility, {
      publishedVisibility: args.visibility,
      schemaId: args.schemaId,
    });
  },
  returns: v.null(),
});

/**
 * One-off maintenance for the denormalized dataset summaries (issue #54):
 * stamps `entryCount` onto every dataset and `kind` onto pre-field collection
 * membership rows inside the component. Idempotent — rerun any time drift is
 * suspected (it recomputes from source). Internal on purpose: no app surface
 * drives it, and a signed-in gate would be theater — internal functions are
 * already unreachable by clients. The sign-in gate (roadmap 0.1) rejected
 * its old `convex run` path only because that ran it as a PUBLIC function
 * with no identity; internal functions run via the CLI with admin auth
 * (the seed.ts precedent).
 *
 * Run with: `bunx convex run schemas:backfillSummaries` (from app/)
 */
export const backfillSummaries = internalMutation({
  args: {},
  handler: async (ctx) => ctx.runMutation(components.jsonCms.lib.backfillDatasetSummaries, {}),
  returns: v.object({
    membershipsPatched: v.number(),
    schemasPatched: v.number(),
  }),
});

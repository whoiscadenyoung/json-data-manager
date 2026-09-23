import { exposeApi } from "@caden/json-cms";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation, query } from "./_generated/server";
import { auth } from "./auth";

export const {
  listSchemas: list,
  listSchemaSummaries: listSummaries,
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
 */
export const maxTileCacheVersion = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {});
    let max = 0;
    for (const schema of schemas) {
      max = Math.max(max, schema.mapTileCacheVersion ?? 0);
    }
    return max;
  },
  returns: v.number(),
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
  handler: async (ctx) =>
    ctx.runMutation(components.jsonCms.lib.backfillDatasetSummaries, {}),
  returns: v.object({
    membershipsPatched: v.number(),
    schemasPatched: v.number(),
  }),
});

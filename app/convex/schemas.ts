import { v } from "convex/values";

import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";
import { mutation, query } from "./_generated/server";

export const {
  listSchemas: list,
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
 * every schema row.
 */
export const maxTileCacheVersion = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemas, {});
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
 * membership rows inside the component. Idempotent — run via
 * `bunx convex run schemas:backfillSummaries` after a deploy that introduces
 * the fields, or any time drift is suspected (it recomputes from source).
 */
export const backfillSummaries = mutation({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    return ctx.runMutation(components.jsonCms.lib.backfillDatasetSummaries, {});
  },
  returns: v.object({
    membershipsPatched: v.number(),
    schemasPatched: v.number(),
  }),
});

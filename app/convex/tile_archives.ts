import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { auth } from "./auth";

/**
 * Installs a freshly generated tile archive onto a dataset, guarded by the
 * version the rebuild worker snapshotted before generating (`expectedVersion`
 * — see the component's `setMapTileArchive` for the guard semantics: a
 * rebuild raced by edits self-discards).
 *
 * Deliberately a THIN app-level wrapper around
 * `components.jsonCms.lib.setMapTileArchive` (issue #58 part 3): the
 * component function is public (the generated ComponentApi only carries
 * public functions — a component-internal one would be invisible to this
 * host app entirely) but is NOT re-exported through `exposeApi`, so no
 * browser client has a path to it. Only the rebuild worker — via its
 * standalone ConvexClient — reaches this mutation. Ids arrive as plain
 * strings (`v.string()`, like every exposeApi boundary); the component
 * re-validates them against its own tables. `auth` runs here so the seam
 * matches every exposeApi wrapper (anonymous while the app has no auth).
 *
 * Returns whether the install took: `setMapTileArchive` is
 * indistinguishable-by-result between "installed" and "stale-discarded"
 * (the guard's discard is a silent no-op that deletes the incoming blob),
 * so this re-reads the archive meta in the same transaction and compares
 * pointers — the worker's progress reporting needs the outcome.
 */
export const install = mutation({
  args: {
    bytes: v.number(),
    expectedVersion: v.number(),
    maxZoom: v.number(),
    schemaId: v.string(),
    storageId: v.string(),
  },
  handler: async (ctx, args) => {
    await auth(ctx);
    await ctx.runMutation(components.jsonCms.lib.setMapTileArchive, {
      bytes: args.bytes,
      expectedVersion: args.expectedVersion,
      maxZoom: args.maxZoom,
      schemaId: args.schemaId,
      storageId: args.storageId,
    });
    const meta = await ctx.runQuery(components.jsonCms.lib.getMapTileArchiveMeta, {
      schemaId: args.schemaId,
    });
    return meta !== null && meta.storageId === args.storageId
      ? ("installed" as const)
      : ("discarded" as const);
  },
  returns: v.union(v.literal("installed"), v.literal("discarded")),
});

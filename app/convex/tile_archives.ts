import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
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
 * re-validates them against its own tables. `auth` runs here WITH the
 * schema operation (issue #131), so the install answers to the same
 * visibility policy as every other write — and `type: "update"` with no
 * entry keeps the read-only gate out of the way, exactly as for metadata
 * writes: a rendering cache is not data, and bound datasets keep theirs.
 *
 * Storage-id provenance (issue #131): the archive blob must present the
 * `uploadId` its upload URL was issued under, claimed here for THIS schema
 * before the install — a blob id that didn't come from a server-issued
 * upload for this dataset is rejected, never installed (and never deleted
 * on a stale path it doesn't belong to).
 *
 * Returns whether the install took: `setMapTileArchive` is
 * indistinguishable-by-result between "installed" and "stale-discarded"
 * (the guard's discard is a silent no-op that deletes the incoming blob),
 * so this probes the incoming blob through the component in the same
 * transaction (component storage is namespaced — the host's own
 * `ctx.storage` can't see it): "installed" iff the blob survived the call,
 * which is exactly the install path; both discard paths (stale version,
 * dataset gone) delete it.
 */
export const install = mutation({
  args: {
    bytes: v.number(),
    expectedVersion: v.number(),
    maxZoom: v.number(),
    schemaId: v.string(),
    storageId: v.string(),
    uploadId: v.string(),
  },
  handler: async (ctx, args) => {
    await auth(ctx, { fn: "tile_archives.install", schemaId: args.schemaId, type: "update" });
    await ctx.runMutation(components.jsonCms.host_support.claimUpload, {
      scope: args.schemaId,
      uploadId: args.uploadId,
    });
    await ctx.runMutation(components.jsonCms.lib.setMapTileArchive, {
      bytes: args.bytes,
      expectedVersion: args.expectedVersion,
      maxZoom: args.maxZoom,
      schemaId: args.schemaId,
      storageId: args.storageId,
    });
    const incoming = await ctx.runQuery(components.jsonCms.host_support.hasStorageBlob, {
      storageId: args.storageId,
    });
    return incoming ? ("installed" as const) : ("discarded" as const);
  },
  returns: v.union(v.literal("installed"), v.literal("discarded")),
});

/**
 * Tile-archive metadata for several datasets in one query, aligned with the
 * input order (an id that appears twice is fetched once and appears twice —
 * map the result onto the caller's list by index).
 *
 * One subscription for N datasets is what keeps the source-selection helper
 * (`app/src/lib/layer-source.ts`) hook-rules-clean: React can't call
 * `useQuery` per id inside a loop, and the component's own
 * `getMapTileArchiveMeta` takes a single schema id (the react package's
 * `useMapTileArchiveMeta` likewise needs the provider surface this app
 * doesn't mount). Returns `null` per id with no current archive — the
 * row-path decision; the caller never hits the network for a tile that
 * isn't there.
 */
export const metas = query({
  args: { schemaIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await auth(ctx);
    const unique = [...new Set(args.schemaIds)],
      resolved = await Promise.all(
        unique.map(async (schemaId) =>
          ctx.runQuery(components.jsonCms.lib.getMapTileArchiveMeta, { schemaId }),
        ),
      ),
      bySchemaId = new Map(unique.map((schemaId, index) => [schemaId, resolved[index]]));
    return args.schemaIds.map((schemaId) => bySchemaId.get(schemaId) ?? null);
  },
  returns: v.array(
    v.union(
      v.null(),
      v.object({
        bytes: v.optional(v.number()),
        maxZoom: v.optional(v.number()),
        // Deliberately NO `storageId` (issue #131): clients decide the tile
        // path from `url` + `version` alone — a `_storage` id here would
        // hand every signed-in client the archive blob pointers of every
        // requested dataset.
        url: v.string(),
        version: v.number(),
      }),
    ),
  ),
});

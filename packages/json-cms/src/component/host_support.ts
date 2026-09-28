import { v } from "convex/values";

import { action, mutation } from "./_generated/server.js";

/**
 * Host support surface — the small host-only helpers the publish flow
 * (roadmap 5b) needs that have no user-facing meaning. Component functions
 * are reachable solely through host code (the exposeApi wrapper decides what
 * browsers can call, and NONE of these is ever wired into it), so "public"
 * here means host-callable, not client-facing.
 */

/**
 * Test support for HOST test suites that drive `startImport` end to end
 * under convex-test: stores one blob in the COMPONENT's file storage and
 * returns its id.
 *
 * Why this exists: chunk blobs are produced client-side through
 * `generateUploadUrl` + an HTTP POST — a route convex-test does not serve —
 * and component storage is namespaced, so a blob the HOST stores is invisible
 * to the component's own `insertChunkFromStorage` action. This action is the
 * bridge, sized for the tiny chunks a test plants (per-value platform limit).
 */
export const storeTestBlob = action({
  args: { bytes: v.bytes() },
  handler: async (ctx, args) => ctx.storage.store(new Blob([args.bytes])),
  returns: v.id("_storage"),
});

/**
 * Best-effort delete of storage blobs by id — the host-side cleanup the
 * publish flow needs (`resetUpload` on a discarded plan, a failed publish
 * attempt): component storage is namespaced, so the HOST's
 * `ctx.storage.delete` cannot reach blobs the component's upload URL
 * created, and blobs never registered with an import are invisible to the
 * component's own failed-import cleanup (`handleImportComplete` deletes only
 * the `storageIds` an import carried). Each id deletes independently; an
 * already-gone blob is a harmless no-op (the `tryDeleteStorage` precedent in
 * lib.ts).
 */
export const deleteStorageBlobs = mutation({
  args: { storageIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const storageId of args.storageIds) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- ordered best-effort deletes under the transaction's write budget. (The string overload of `storage.delete` is documented-deprecated but exact for these host-boundary ids — see the module doc on why they arrive as strings.)
        await ctx.storage.delete(storageId);
        deleted += 1;
      } catch {
        // Already deleted, or never existed — this is best-effort cleanup.
      }
    }
    return deleted;
  },
  returns: v.number(),
});

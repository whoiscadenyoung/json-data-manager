import { ConvexError, v } from "convex/values";

import { api } from "./_generated/api.js";
import { action, mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";

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

// --- Upload provenance (issue #131) ---
//
// Every storage blob a CLIENT uploads arrives through a URL this component's
// `generateUploadUrl` minted — and every such mint records one `pendingUploads`
// row. Presenting a storage id to a consumer (chunk registration, tile
// install, `startImport`'s client path) therefore requires a claim against a
// live row with the consumer's scope: an unknown, already-used, or
// differently-scoped token rejects the id, so one client can no longer feed
// another dataset's blob ids into its own attempt or import.

/**
 * How long an issued-but-never-claimed upload row survives before
 * `sweepAbandonedUploads` deletes it. Generous on purpose: a publish or
 * import keeps its browser alive across chunk uploads, and a resumed client
 * always mints fresh URLs, so nothing legitimate ever needs an old row.
 */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** How many abandoned rows one sweep invocation deletes before it schedules its continuation. */
const SWEEP_BATCH = 100;

/**
 * Claims one pending upload for a consumer: the row must exist, never have
 * been claimed, and carry exactly the consumer's scope. The claim DELETES the
 * row — custody of the uploaded blob transfers to the consuming flow (the
 * attempt's failure cleanup, the import workflow's per-chunk deletes), so the
 * table only ever holds uploads that never reached a consumer. Runs inside
 * the caller's transaction: a rejected claim rolls the whole consumer back.
 * (The presented storage id itself is not re-derivable server-side — Convex
 * only reports it to the uploading client — so the token + scope pair is the
 * entire provenance guarantee: the blob was uploaded through a URL issued
 * for this target.)
 *
 * Shared by the host-side `claimUpload` mutation and `startImport`'s client
 * path (same module boundary as the rest of this file).
 */
export async function claimPendingUpload(
  ctx: MutationCtx,
  uploadId: string,
  scope: string,
): Promise<void> {
  const rowId = ctx.db.normalizeId("pendingUploads", uploadId);
  if (rowId === null) {
    throw new ConvexError(
      "This upload was never issued by the server — request a fresh upload URL and re-upload.",
    );
  }
  const row = await ctx.db.get(rowId);
  if (row === null) {
    // A fabricated id normalizes nowhere; a consumed one was deleted by its
    // claim — either way the presented token proves nothing.
    throw new ConvexError(
      "This upload was never issued by the server — request a fresh upload URL and re-upload.",
    );
  }
  if (row.scope !== scope) {
    throw new ConvexError(
      "This upload was issued for a different dataset or publish attempt — request a fresh upload URL for this target.",
    );
  }
  // Delete, not patch: the row's whole job is this one hand-off, and a gone
  // row is what makes a replayed claim fail closed.
  await ctx.db.delete(rowId);
}

/** The host-callable claim (see `claimPendingUpload`). */
export const claimUpload = mutation({
  args: { scope: v.string(), uploadId: v.string() },
  handler: async (ctx, args) => {
    await claimPendingUpload(ctx, args.uploadId, args.scope);
  },
  returns: v.null(),
});

/**
 * Whether a blob still exists in the component's storage — the tile-install
 * outcome probe: the component's `setMapTileArchive` deletes the incoming
 * blob on every discard path (stale version, dataset gone) and keeps it only
 * on a real install, so post-call existence IS the installed/discarded
 * answer without ever re-reading a `_storage` id into a client-visible
 * result (issue #131).
 */
export const hasStorageBlob = query({
  args: { storageId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.system.normalizeId("_storage", args.storageId);
    if (id === null) {
      return false;
    }
    return (await ctx.db.system.get("_storage", id)) !== null;
  },
  returns: v.boolean(),
});

/**
 * Sweeps issued-but-never-claimed upload rows older than the TTL
 * (`PENDING_UPLOAD_TTL_MS`, overridable via `olderThanMs` for tests): the
 * client uploaded nothing against them, or died before its consumer call —
 * either way the row is dead weight and, swept, ends the URL's existence.
 * Ascending creation order means the first row inside the TTL ends the
 * scan; a full batch schedules one continuation, so the sweep drains any
 * backlog across scheduled runs. A blob the client uploaded but never
 * registered is unfortunately invisible to ANY server-side record (Convex
 * only reports the id to the uploading client) — this sweep is the record
 * hygiene the issue asks for, and the provenance claims above are what keep
 * such blobs unadoptable.
 *
 * Public-but-unexposed (the `deleteStorageBlobs` pattern): the HOST's cron
 * drives the sweep, and a host cannot reach a component-internal function.
 */
export const sweepAbandonedUploads = mutation({
  args: { olderThanMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ttl = args.olderThanMs ?? PENDING_UPLOAD_TTL_MS,
      cutoff = Date.now() - ttl;
    let swept = 0;
    for await (const row of ctx.db.query("pendingUploads").order("asc")) {
      if (row._creationTime >= cutoff) {
        break; // ascending order: everything after this is younger.
      }
      await ctx.db.delete(row._id);
      swept += 1;
      if (swept === SWEEP_BATCH) {
        await ctx.scheduler.runAfter(0, api.host_support.sweepAbandonedUploads, {
          olderThanMs: args.olderThanMs,
        });
        break;
      }
    }
    return swept;
  },
  returns: v.number(),
});

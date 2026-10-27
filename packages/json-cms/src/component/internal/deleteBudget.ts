import type { Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import type { EntryDbRow } from "./entryPages.js";
import { deleteGeometryStorageIfAny, deleteReferencesForEntry } from "./entryWrites.js";

// ---------------------------------------------------------------------------
// Batched, budget-aware deletes (issue #128)
//
// Convex caps a single mutation at ~16k documents written, ~32k read and
// ~16 MiB read, so a dataset of a few thousand entries with geometry cannot
// be deleted or cleared in one transaction. Both `deleteSchema` and
// `deleteEntriesBySchema` therefore drain in batches: each pass deletes up
// to one budget-sized batch — every entry together with its references rows
// (both sides), its geometry row, and that row's storage blob — then checks
// the transaction's remaining read budget and, while rows remain and the
// budget is nearly spent, schedules itself for a fresh transaction
// (`ctx.scheduler.runAfter(0, …)`) instead of blowing the cap.
//
// Small datasets — every fixture-sized one — still complete SYNCHRONOUSLY
// inside the calling mutation, so the delete/clear contract is unchanged for
// them; a large drain finishes across subsequent scheduled transactions and
// always ends with the schema row itself deleted LAST (a clear resets the
// schema row's counters instead), so no child ever dangles mid-drain.
// ---------------------------------------------------------------------------

/** Rows per `.take()` while the delete budget is plentiful. */
export const DELETE_BATCH_ROWS = 100,
  // Stop draining inline once the transaction's remaining read budget falls
  // under this — the next batch (up to DELETE_BATCH_ROWS fat entry docs)
  // still needs headroom — and hand off to a scheduled continuation.
  DELETE_BYTE_RESERVE = 4_000_000,
  // Conservative per-row read estimate used to size each batch DOWN as the
  // budget drains (an entry doc plus its geometry row; `data` payloads vary,
  // so the estimate assumes a fat row).
  DELETE_ROW_BYTE_ESTIMATE = 100_000;

/** The transaction's remaining read budget, or null when the context cannot
 * report it (contexts without metrics — the test simulator among them —
 * fall back to the fixed batch cap, which alone sits far under every limit). */
export async function transactionReadRemaining(ctx: MutationCtx): Promise<number | null> {
  try {
    return (await ctx.meta.getTransactionMetrics()).bytesRead.remaining;
  } catch {
    return null;
  }
}

/**
 * One bounded delete batch's width: never above `DELETE_BATCH_ROWS`, shrunk
 * to what the transaction's remaining read budget can absorb. Zero means
 * "the budget says hand off to a scheduled continuation now".
 */
async function deleteBatchWidth(ctx: MutationCtx): Promise<number> {
  const remaining = await transactionReadRemaining(ctx);
  if (remaining === null) {
    return DELETE_BATCH_ROWS;
  }
  if (remaining <= DELETE_BYTE_RESERVE) {
    return 0;
  }
  return Math.min(
    DELETE_BATCH_ROWS,
    Math.floor((remaining - DELETE_BYTE_RESERVE) / DELETE_ROW_BYTE_ESTIMATE),
  );
}

/** Deletes one entry with everything hanging off it: its references rows (as source AND as target — every reference naming one of this schema's entries names one of its entries), its geometry row, and that row's storage blob. */
async function deleteEntryWithCascade(ctx: MutationCtx, entry: EntryDbRow): Promise<void> {
  const geometry = entry.geometryId !== undefined ? await ctx.db.get(entry.geometryId) : null;
  if (entry.geometryId !== undefined) {
    await ctx.db.delete(entry.geometryId);
  }
  await deleteGeometryStorageIfAny(ctx, geometry);
  await deleteReferencesForEntry(ctx, entry._id);
  await ctx.db.delete(entry._id);
}

/** Deletes one geometry row together with its storage blob (the leftover-geometry drain's row unit). */
async function deleteGeometryWithBlob(
  ctx: MutationCtx,
  geometryId: Id<"geometries">,
): Promise<void> {
  const geometry = await ctx.db.get(geometryId);
  await ctx.db.delete(geometryId);
  await deleteGeometryStorageIfAny(ctx, geometry);
}
type DeletePhase = "entries" | "geometries" | "finish";

/** Drains the schema's entries (each with its cascades) until the index is empty or the read budget says hand off. Accumulates into `deleted.entries` when the caller tracks the count. */
async function drainEntriesPhase(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  deleted?: { entries: number },
): Promise<"drained" | "more"> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each batch resumes from the previous batch's budget; the drain is inherently sequential.
    const width = await deleteBatchWidth(ctx);
    if (width === 0) {
      return "more";
    }
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const rows = await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
      .take(width);
    if (rows.length === 0) {
      return "drained";
    }
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await Promise.all(rows.map(async (entry) => deleteEntryWithCascade(ctx, entry)));
    if (deleted !== undefined) {
      deleted.entries += rows.length;
    }
    if (rows.length < width) {
      return "drained"; // The index ran dry inside this batch.
    }
  }
}

/** Drains the schema's leftover `geometries` rows (each with its blob) until the index is empty or the budget says hand off. */
async function drainGeometriesPhase(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
): Promise<"drained" | "more"> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each batch resumes from the previous batch's budget; the drain is inherently sequential.
    const width = await deleteBatchWidth(ctx);
    if (width === 0) {
      return "more";
    }
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const rows = await ctx.db
      .query("geometries")
      .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
      .take(width);
    if (rows.length === 0) {
      return "drained";
    }
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await Promise.all(rows.map(async (row) => deleteGeometryWithBlob(ctx, row._id)));
    if (rows.length < width) {
      return "drained";
    }
  }
}

/**
 * The clear's finisher: counters to zero, the five tile-archive fields
 * cleared (the archive blob itself was deleted with the data) — and
 * `mapTileCacheVersion` bumped MONOTONICALLY past every version a pre-clear
 * rebuild or OPFS pin could have snapshotted (issue #129, revising the
 * recorded exact-reset decision: a reset to 0 would let a stale archive
 * built at version N pass the `setMapTileArchive` `expectedVersion` guard
 * once a re-import climbed back to N — see `deleteEntriesBySchema`).
 */
export async function finishClear(ctx: MutationCtx, schemaId: Id<"schemas">): Promise<void> {
  const doc = await ctx.db.get(schemaId);
  if (doc === null) {
    return;
  }
  await ctx.db.patch(schemaId, {
    boundingBox: undefined,
    entryCount: 0,
    featureCount: doc.kind === "geospatial" ? 0 : undefined,
    mapTileArchiveBuiltVersion: undefined,
    mapTileArchiveBytes: undefined,
    mapTileArchiveFormat: undefined,
    mapTileArchiveMaxZoom: undefined,
    mapTileArchiveStorageId: undefined,
    // Monotonic bump, never a reset: the version is now "how many
    // geometry-affecting writes this dataset has ever seen" (see the field's
    // doc on the `schemas` table).
    mapTileCacheVersion: (doc.mapTileCacheVersion ?? 0) + 1,
  });
}

/**
 * Drives `phase` — and every phase after it — of a schema delete or clear to
 * completion within this transaction. Returns the phase to resume from when
 * the read budget stopped the drain (`complete: false`); the caller then
 * schedules its continuation step with exactly that phase. `finish` is the
 * mutator-specific endgame (`finishClear` vs `finishSchemaDelete`).
 */
export async function runDeletePhases(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  phase: DeletePhase,
  finish: (ctx: MutationCtx, schemaId: Id<"schemas">) => Promise<void>,
  deleted?: { entries: number },
): Promise<{ complete: boolean; phase: DeletePhase }> {
  let at = phase;
  if (at === "entries") {
    if ((await drainEntriesPhase(ctx, schemaId, deleted)) === "more") {
      return { complete: false, phase: at };
    }
    at = "geometries";
  }
  if (at === "geometries") {
    if ((await drainGeometriesPhase(ctx, schemaId)) === "more") {
      return { complete: false, phase: at };
    }
    at = "finish";
  }
  await finish(ctx, schemaId);
  return { complete: true, phase: at };
}

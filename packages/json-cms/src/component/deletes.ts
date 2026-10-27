import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { DELETE_BATCH_ROWS, finishClear, runDeletePhases } from "./internal/deleteBudget.js";
import { deleteMapLayersForTarget } from "./internal/mapLayers.js";
import { assertDataWritable, boundWriteValidator } from "./internal/shared.js";

// Batched, budget-aware deletes (issue #128) — the batching/budget
// mechanics and their rationale live in internal/deleteBudget.ts.

/** The phases a schema delete / clear walks, in drain order: entries (each with its references, geometry, blob) → leftover geometry rows → the mutator-specific finisher. */
const deletePhaseValidator = v.union(
  v.literal("entries"),
  v.literal("geometries"),
  v.literal("finish"),
);

/** Deletes one import status doc together with any chunk blobs it still points at (unconsumed leftovers of a failed/canceled import — consumed chunks already deleted their own). */
async function deleteImportWithBlobs(ctx: MutationCtx, row: Doc<"imports">): Promise<void> {
  await Promise.all([
    ...(row.storageIds ?? []).map(async (storageId) => {
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // Already consumed or already gone — best-effort cleanup.
      }
    }),
    (async () => {
      if (row.storageId !== undefined) {
        try {
          await ctx.storage.delete(row.storageId);
        } catch {
          // Same — best-effort (the deprecated single-blob form).
        }
      }
    })(),
  ]);
  await ctx.db.delete(row._id);
}

/** The delete's finisher: collection memberships, then any map layers pointing at the dataset (their override rows too), then the schema row itself — deleted LAST, so no child ever dangles mid-drain. */
async function finishSchemaDelete(ctx: MutationCtx, schemaId: Id<"schemas">): Promise<void> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each batch only exists because the previous one was full; inherently sequential.
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
      .take(DELETE_BATCH_ROWS);
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await Promise.all(memberships.map(async (row) => ctx.db.delete(row._id)));
    if (memberships.length < DELETE_BATCH_ROWS) {
      break;
    }
  }
  // Import status docs go with the dataset — each carrying its leftover
  // chunk blobs (issue #129: `imports` rows were never cleaned up here, so
  // a dataset's failed-import records and their unconsumed blobs outlived
  // it).
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each batch only exists because the previous one was full; inherently sequential.
    const imports = await ctx.db
      .query("imports")
      .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
      .take(DELETE_BATCH_ROWS);
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await Promise.all(imports.map(async (row) => deleteImportWithBlobs(ctx, row)));
    if (imports.length < DELETE_BATCH_ROWS) {
      break;
    }
  }
  await deleteMapLayersForTarget(ctx, schemaId);
  if ((await ctx.db.get(schemaId)) !== null) {
    await ctx.db.delete(schemaId);
  }
}

/** Continuation hop for `deleteEntriesBySchema`'s drain (issue #128): resumes at `phase` and reschedules itself until the clear is complete. A schema deleted mid-clear stops the drain — the delete flow's own steps own the row. */
export const clearEntriesStep = internalMutation({
  args: { phase: deletePhaseValidator, schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    if ((await ctx.db.get(args.schemaId)) === null) {
      return;
    }
    const { complete, phase } = await runDeletePhases(ctx, args.schemaId, args.phase, finishClear);
    if (!complete) {
      await ctx.scheduler.runAfter(0, internal.deletes.clearEntriesStep, {
        phase,
        schemaId: args.schemaId,
      });
    }
  },
  returns: v.null(),
});

/** Continuation hop for `deleteSchema`'s drain — the same loop, with the schema row deleted last. */
export const deleteSchemaStep = internalMutation({
  args: { phase: deletePhaseValidator, schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    if ((await ctx.db.get(args.schemaId)) === null) {
      return;
    }
    const { complete, phase } = await runDeletePhases(
      ctx,
      args.schemaId,
      args.phase,
      finishSchemaDelete,
    );
    if (!complete) {
      await ctx.scheduler.runAfter(0, internal.deletes.deleteSchemaStep, {
        phase,
        schemaId: args.schemaId,
      });
    }
  },
  returns: v.null(),
});

export const deleteSchema = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }
    // Deleting a dataset deletes its data, so a bound dataset's deletion
    // belongs to the host's unbind/retirement flows only.
    assertDataWritable(existing, args.boundWrite);

    // The retained original import file and the tile archive's blob go in
    // this first transaction — nothing outside the schema doc references
    // either (see setMapTileArchive / startImport), and the drain below never
    // touches them.
    if (existing.sourceFileStorageId !== undefined) {
      await ctx.storage.delete(existing.sourceFileStorageId);
    }
    if (existing.mapTileArchiveStorageId !== undefined) {
      await ctx.storage.delete(existing.mapTileArchiveStorageId);
    }

    const { complete, phase } = await runDeletePhases(
      ctx,
      args.schemaId,
      "entries",
      finishSchemaDelete,
    );
    if (!complete) {
      // Big dataset: the drain continues across scheduled transactions and
      // deletes the schema row last (see `deleteSchemaStep`).
      await ctx.scheduler.runAfter(0, internal.deletes.deleteSchemaStep, {
        phase,
        schemaId: args.schemaId,
      });
    }
  },
});

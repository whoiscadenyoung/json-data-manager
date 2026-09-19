import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { chunkByJsonBytes, getSource, type ProjectionRow, SOURCE_KEY } from "./sources";

/**
 * The durable sync engine for bound datasets (docs/bound-datasets-design.md
 * §5, issue #76). The v1 sync was a single clear-then-reload mutation —
 * capped, and lost wholesale if the transaction failed. This engine models
 * the component's importWorkflow instead:
 *
 * 1. `startRun` (public; the dashboard's Sync/Reconcile buttons) ensures the
 *    bound dataset exists, guards against a concurrent run, and schedules
 *    the collect step. "sync" and "reconcile" share the whole engine — a
 *    reconcile is the same full diff-and-repair pass, recorded as such.
 * 2. `collectRows` (action) reads the source's full state through its
 *    descriptor (`sources.ts`) and stores it as chunk blobs in app storage.
 * 3. `applyChunks` (action) walks the chunks, calling `applyRowsBatch` per
 *    small batch of rows. Every batch is checkpointed on the run doc
 *    (`chunkIndex`/`rowOffset`), and every row applies idempotently by its
 *    foreign key through the `bindingEntries` map — an interrupted run
 *    resumes exactly where it stopped, neither duplicating nor losing rows.
 * 4. `finalizeRun` deletes the projections of keys the run never saw
 *    (deletes come from diffing the key map, not from a clear-everything),
 *    writes the activity row, and stamps the binding.
 *
 * Writes go through the component's public entry mutations with the
 * host-only `boundWrite` attestation (#75) — component internals are not
 * reachable from the host, and the read-only gate requires the attestation.
 */

const ACTIVITY_OPS_LIMIT = 200,
  // Rows per applying batch — entries are thin (Points), so 100 writes with
  // their geometry reads sit far inside a transaction's limits.
  APPLY_BATCH_ROWS = 100,
  // A run whose checkpoint hasn't moved for this long is considered dead
  // (its action was lost to a restart) and gets resumed rather than blocked
  // on.
  STALE_RUN_MS = 2 * 60 * 1000;

function rowLabel(row: ProjectionRow): string {
  if (typeof row.data.label === "string") {
    return row.data.label;
  }
  if (typeof row.data.name === "string") {
    return row.data.name;
  }
  return row.key;
}

/** Field-level before→after detail for one updated row (History-tab format). */
function diffRowDetail(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | undefined {
  const changes: string[] = [];
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of fields) {
    const beforeValue = JSON.stringify(before[field]),
      afterValue = JSON.stringify(after[field]);
    if (beforeValue !== afterValue) {
      changes.push(`${field}: ${beforeValue} → ${afterValue}`);
    }
  }
  return changes.length === 0 ? undefined : changes.join("; ");
}

/** Find-or-create the "External demo" collection grouping bound datasets. */
async function ensureCollection(ctx: MutationCtx): Promise<string> {
  const COLLECTION_NAME = "External demo";
  const collections = await ctx.runQuery(components.jsonCms.lib.listCollections, {});
  const existing = collections.find((collection) => collection.name === COLLECTION_NAME);
  if (existing !== undefined) {
    return existing._id;
  }
  return ctx.runMutation(components.jsonCms.lib.createCollection, {
    description: "Datasets projected from the app's own tables — the bound-datasets PoC.",
    name: COLLECTION_NAME,
  });
}

/**
 * Find-or-create the bound dataset + binding row for one source. The
 * dataset is created from the source's descriptor, marked read-only at the
 * component (`source: { name: key }`), and filed into the shared collection.
 */
async function ensureBoundDataset(
  ctx: MutationCtx,
  sourceKey: string,
): Promise<{ bindingId: Id<"datasetBindings">; schemaId: string }> {
  const source = getSource(sourceKey);
  const collectionId = await ensureCollection(ctx);

  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_source", (q) => q.eq("source", sourceKey))
    .first();
  if (binding === null) {
    const schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
      geometryType: source.dataset.geometryType,
      kind: source.dataset.kind,
      schema: source.dataset.schema,
      source: { name: sourceKey },
    });
    await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
      collectionId,
      schemaId,
    });
    const bindingId = await ctx.db.insert("datasetBindings", {
      collectionId,
      schemaId,
      schemaMapping: source.mapping,
      source: sourceKey,
    });
    return { bindingId, schemaId };
  }

  // Migrate datasets created before the source marker existed: a bound
  // dataset without `source` is deleted and recreated so the read-only
  // marker (and the component-level gate) is present everywhere it is read.
  let schemaId = binding.schemaId;
  const existing = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  if (existing === null || existing.source === undefined) {
    if (existing !== null) {
      // The legacy copy is unmarked, so the gate allows this delete.
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, { schemaId });
    }
    schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
      geometryType: source.dataset.geometryType,
      kind: source.dataset.kind,
      schema: source.dataset.schema,
      source: { name: sourceKey },
    });
    await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
      collectionId,
      schemaId,
    });
  }
  await ctx.db.patch(binding._id, { collectionId, schemaId, schemaMapping: source.mapping });
  return { bindingId: binding._id, schemaId };
}

async function startRunInternal(
  ctx: MutationCtx,
  args: { mode: "reconcile" | "sync"; source: string },
): Promise<{ alreadyRunning: boolean; runId: Id<"syncRuns"> }> {
  const source = getSource(args.source);
  const { bindingId, schemaId } = await ensureBoundDataset(ctx, args.source);

  // First engine run over a pre-engine projection: its rows predate the
  // key map, so a keyed apply would leave them as unmanaged strays. Clear
  // them once; the keyed apply then repopulates from scratch. (`.first()`
  // resolves to NULL, not undefined, on an empty index — the same trap the
  // auth gate hit.)
  const existingMapping = await ctx.db
    .query("bindingEntries")
    .withIndex("by_binding", (q) => q.eq("bindingId", bindingId))
    .first();
  if (existingMapping === null) {
    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
    if (schema !== null && (schema.entryCount ?? 0) > 0) {
      await ctx.runMutation(components.jsonCms.lib.deleteEntriesBySchema, {
        boundWrite: "sync",
        schemaId,
      });
    }
  }

  const lastRun = await ctx.db
    .query("syncRuns")
    .withIndex("by_binding", (q) => q.eq("bindingId", bindingId))
    .order("desc")
    .first();
  if (lastRun !== null && (lastRun.status === "applying" || lastRun.status === "collecting")) {
    // An active run — join it instead of forking a second one. A run whose
    // checkpoint went quiet is dead (its action was lost); the checkpoint
    // makes resuming it safe, which is the durability the engine exists for.
    if (Date.now() - lastRun.lastProgressAt < STALE_RUN_MS) {
      return { alreadyRunning: true, runId: lastRun._id };
    }
    await ctx.db.patch(lastRun._id, { lastProgressAt: Date.now() });
    if (lastRun.status === "applying") {
      await ctx.scheduler.runAfter(0, internal.sync.applyChunks, { runId: lastRun._id });
    } else {
      await ctx.scheduler.runAfter(0, internal.sync.collectRows, {
        runId: lastRun._id,
        source: args.source,
      });
    }
    return { alreadyRunning: true, runId: lastRun._id };
  }

  const runId = await ctx.db.insert("syncRuns", {
    added: 0,
    applied: 0,
    bindingId,
    chunkIndex: 0,
    chunkStorageIds: [],
    lastProgressAt: Date.now(),
    mode: args.mode,
    ops: [],
    removed: 0,
    rowOffset: 0,
    source: source.key,
    startedAt: Date.now(),
    status: "collecting",
    total: 0,
    truncated: false,
    updated: 0,
  });
  await ctx.scheduler.runAfter(0, internal.sync.collectRows, {
    runId,
    source: args.source,
  });
  return { alreadyRunning: false, runId };
}

/** Kick off a durable sync of one bound source (the dashboard's Sync now). */
export const startRun = mutation({
  args: {
    mode: v.union(v.literal("reconcile"), v.literal("sync")),
    source: v.string(),
  },
  handler: async (ctx, args) => startRunInternal(ctx, args),
  returns: v.object({
    alreadyRunning: v.boolean(),
    runId: v.id("syncRuns"),
  }),
});

/** Convenience wrapper for the primary demo source (CLI + old bookmarks). */
export const syncRestaurantLocations = mutation({
  args: {},
  handler: async (ctx) => {
    const result = await startRunInternal(ctx, { mode: "sync", source: SOURCE_KEY });
    return { alreadyRunning: result.alreadyRunning, runId: result.runId };
  },
  returns: v.object({ alreadyRunning: v.boolean(), runId: v.id("syncRuns") }),
});

/** The latest run for one source, for the dashboard's live progress row. */
export const latestRun = query({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .first();
    if (binding === null) {
      return null;
    }
    // Light projection — the client row shows progress and the last result.
    const run = await ctx.db
      .query("syncRuns")
      .withIndex("by_binding", (q) => q.eq("bindingId", binding._id))
      .order("desc")
      .first();
    if (run === null) {
      return null;
    }
    return {
      _creationTime: run._creationTime,
      _id: run._id,
      added: run.added,
      applied: run.applied,
      error: run.error,
      finishedAt: run.finishedAt,
      mode: run.mode,
      removed: run.removed,
      startedAt: run.startedAt,
      status: run.status,
      total: run.total,
      updated: run.updated,
    };
  },
  returns: v.union(
    v.null(),
    v.object({
      _creationTime: v.number(),
      _id: v.id("syncRuns"),
      added: v.number(),
      applied: v.number(),
      error: v.optional(v.string()),
      finishedAt: v.optional(v.number()),
      mode: v.union(v.literal("reconcile"), v.literal("sync")),
      removed: v.number(),
      startedAt: v.number(),
      status: v.union(
        v.literal("applying"),
        v.literal("collecting"),
        v.literal("completed"),
        v.literal("failed"),
      ),
      total: v.number(),
      updated: v.number(),
    }),
  ),
});

/** Reads one source's full state — the action-side bridge to its descriptor. */
export const readSourceRows = internalQuery({
  args: { source: v.string() },
  handler: async (ctx, args) => (await getSource(args.source).listRows(ctx)),
  returns: v.array(
    v.object({
      data: v.record(v.string(), v.any()),
      geometry: v.optional(v.any()),
      key: v.string(),
    }),
  ),
});

export const collectRows = internalAction({
  args: { runId: v.id("syncRuns"), source: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.runQuery(internal.sync.getRunDoc, { runId: args.runId });
    if (run === null || run.status !== "collecting") {
      return null;
    }
    const rows: ProjectionRow[] = await ctx.runQuery(internal.sync.readSourceRows, {
      source: args.source,
    });
    // Store the source state as chunk blobs. App storage (not the
    // component's — the apply action reads these back with its own
    // ctx.storage, and component blobs only resolve inside the component).
    const chunkStorageIds: Array<Id<"_storage">> = [];
    for (const chunk of chunkByJsonBytes(rows)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential uploads keep action memory bounded, mirroring the importer.
      const storageId = await ctx.storage.store(
        new Blob([JSON.stringify(chunk)], { type: "application/json" }),
      );
      chunkStorageIds.push(storageId);
    }
    await ctx.runMutation(internal.sync.markCollected, {
      chunkStorageIds,
      runId: args.runId,
      total: rows.length,
    });
    await ctx.scheduler.runAfter(0, internal.sync.applyChunks, { runId: args.runId });
    return null;
  },
});

export const getRunDoc = internalQuery({
  args: { runId: v.id("syncRuns") },
  handler: async (ctx, args) => ctx.db.get(args.runId),
  // Same-module internal read — the doc type IS the validator's shape; keep
  // it loose to avoid re-declaring the full run validator here.
  returns: v.any(),
});

export const markCollected = internalMutation({
  args: {
    chunkStorageIds: v.array(v.id("_storage")),
    runId: v.id("syncRuns"),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status !== "collecting") {
      return;
    }
    // A resumed collect may have stored fresh blobs over stale ones from the
    // interrupted attempt — delete the leftovers so they don't leak.
    await Promise.all(
      run.chunkStorageIds
        .filter((storageId) => !args.chunkStorageIds.includes(storageId))
        .map(async (storageId) => {
          try {
            await ctx.storage.delete(storageId);
          } catch {
            // Best-effort cleanup.
          }
        }),
    );
    await ctx.db.patch(args.runId, {
      chunkIndex: 0,
      chunkStorageIds: args.chunkStorageIds,
      lastProgressAt: Date.now(),
      rowOffset: 0,
      status: "applying",
      total: args.total,
    });
  },
});

export const applyChunks = internalAction({
  args: { runId: v.id("syncRuns") },
  handler: async (ctx, args): Promise<null> => {
    const run: {
      chunkIndex: number;
      chunkStorageIds: Array<Id<"_storage">>;
      rowOffset: number;
      status: string;
    } | null = await ctx.runQuery(internal.sync.getRunDoc, { runId: args.runId });
    if (run === null || run.status !== "applying") {
      return null;
    }
    try {
      for (
        let chunkIndex = run.chunkIndex;
        chunkIndex < run.chunkStorageIds.length;
        chunkIndex += 1
      ) {
        const storageId = run.chunkStorageIds[chunkIndex];
        // oxlint-disable-next-line no-await-in-loop -- chunks apply in order; the checkpoint depends on it.
        const blob = await ctx.storage.get(storageId);
        if (blob === null) {
          throw new Error(`Sync chunk ${chunkIndex} is missing from storage.`);
        }
        // oxlint-disable-next-line no-await-in-loop
        const rows = JSON.parse(await blob.text()) as ProjectionRow[];
        const startOffset = chunkIndex === run.chunkIndex ? run.rowOffset : 0;
        for (let offset = startOffset; offset < rows.length; offset += APPLY_BATCH_ROWS) {
          const batch = rows.slice(offset, offset + APPLY_BATCH_ROWS);
          // oxlint-disable-next-line no-await-in-loop -- each batch's checkpoint depends on the previous one committing.
          await ctx.runMutation(internal.sync.applyRowsBatch, {
            chunkIndex,
            rowOffset: offset + batch.length,
            rows: batch,
            runId: args.runId,
          });
        }
      }
      await ctx.runMutation(internal.sync.finalizeRun, { runId: args.runId });
    } catch (error) {
      await ctx.runMutation(internal.sync.markRunFailed, {
        error: error instanceof Error ? error.message : "Sync failed.",
        runId: args.runId,
      });
    }
    return null;
  },
});

/**
 * Applies one batch of source rows, keyed and idempotently: a key with no
 * map row inserts (entry + map row), a mapped key patches only when its
 * content actually changed, and every map row is stamped with the run so
 * `finalizeRun` can detect deletes. The checkpoint (`chunkIndex`/`rowOffset`)
 * lands in the same transaction as the writes, so a crash can resume
 * without duplicating or skipping a row.
 */
export const applyRowsBatch = internalMutation({
  args: {
    chunkIndex: v.number(),
    rowOffset: v.number(),
    rows: v.array(
      v.object({
        data: v.record(v.string(), v.any()),
        geometry: v.optional(v.any()),
        key: v.string(),
      }),
    ),
    runId: v.id("syncRuns"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status !== "applying") {
      return;
    }
    const binding = await ctx.db.get(run.bindingId);
    if (binding === null) {
      throw new ConvexError("The binding vanished mid-sync.");
    }

    const ops = [...run.ops];
    let truncated = run.truncated;
    let added = 0,
      updated = 0;
    for (const row of args.rows) {
      // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies; each write feeds the next read in this transaction.
      const mapping = await ctx.db
        .query("bindingEntries")
        .withIndex("by_binding", (q) =>
          q.eq("bindingId", run.bindingId).eq("entryKey", row.key),
        )
        .first();
      const hasGeometry =
        row.geometry !== undefined && row.geometry !== null ? true : false;
      const geometryJson = hasGeometry ? JSON.stringify(row.geometry) : undefined;

      if (mapping === null) {
        // oxlint-disable-next-line no-await-in-loop
        const entryId: string = await ctx.runMutation(components.jsonCms.lib.createEntry, {
          boundWrite: "sync",
          data: row.data,
          geometry: geometryJson,
          schemaId: binding.schemaId,
        });
        await ctx.db.insert("bindingEntries", {
          bindingId: run.bindingId,
          entryId,
          entryKey: row.key,
          seenRun: args.runId,
        });
        added += 1;
        if (ops.length < ACTIVITY_OPS_LIMIT) {
          ops.push({ label: rowLabel(row), op: "add" });
        } else {
          truncated = true;
        }
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop
      const entry = await ctx.runQuery(components.jsonCms.lib.getEntry, {
        entryId: mapping.entryId,
      });
      if (entry === null) {
        // Dangling map row (the entry was deleted out of band) — rebuild it.
        // oxlint-disable-next-line no-await-in-loop
        const entryId: string = await ctx.runMutation(components.jsonCms.lib.createEntry, {
          boundWrite: "sync",
          data: row.data,
          geometry: geometryJson,
          schemaId: binding.schemaId,
        });
        await ctx.db.patch(mapping._id, { entryId, seenRun: args.runId });
        added += 1;
        continue;
      }

      const dataChanged = JSON.stringify(entry.data) !== JSON.stringify(row.data);
      // oxlint-disable-next-line no-await-in-loop
      const geometry = await ctx.runQuery(components.jsonCms.lib.getEntryGeometry, {
        entryId: mapping.entryId,
      });
      const geometryChanged =
        geometry === null
          ? hasGeometry
          : !hasGeometry ||
            geometry.geometryJson === undefined ||
            geometry.geometryJson !== geometryJson;
      if (dataChanged || geometryChanged) {
        // oxlint-disable-next-line no-await-in-loop
        await ctx.runMutation(components.jsonCms.lib.updateEntry, {
          boundWrite: "sync",
          data: row.data,
          entryId: mapping.entryId,
          geometry:
            row.geometry === undefined || row.geometry === null
              ? geometry !== null
                ? null
                : undefined
              : geometryJson,
        });
        updated += 1;
        if (ops.length < ACTIVITY_OPS_LIMIT) {
          const before = (entry.data ?? {}) as Record<string, unknown>;
          ops.push({
            detail: dataChanged ? diffRowDetail(before, row.data) : undefined,
            label: rowLabel(row),
            op: "update",
          });
        } else {
          truncated = true;
        }
      } else {
        // Unchanged rows still stamp the map with the run so delete
        // detection sees them as alive.
      }
      await ctx.db.patch(mapping._id, { seenRun: args.runId });
    }

    await ctx.db.patch(args.runId, {
      added: run.added + added,
      applied: run.applied + args.rows.length,
      chunkIndex: args.chunkIndex,
      lastProgressAt: Date.now(),
      ops: ops.slice(0, ACTIVITY_OPS_LIMIT),
      rowOffset: args.rowOffset,
      truncated,
      updated: run.updated + updated,
    });
  },
});

/**
 * Completes a run: deletes every mapped key the run never saw (source
 * deletes, finally for free), stamps the binding, writes the activity row,
 * and cleans up the chunk blobs.
 */
export const finalizeRun = internalMutation({
  args: { runId: v.id("syncRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status !== "applying") {
      return;
    }
    const binding = await ctx.db.get(run.bindingId);
    if (binding === null) {
      throw new ConvexError("The binding vanished mid-sync.");
    }

    const mappings = await ctx.db
      .query("bindingEntries")
      .withIndex("by_binding", (q) => q.eq("bindingId", run.bindingId))
      .collect();
    const stale = mappings.filter((mapping) => mapping.seenRun !== args.runId);
    const ops = [...run.ops];
    let truncated = run.truncated;
    for (const mapping of stale) {
      // oxlint-disable-next-line no-await-in-loop -- ordered deletes under the transaction's write budget.
      await ctx.runMutation(components.jsonCms.lib.deleteEntry, {
        boundWrite: "sync",
        entryId: mapping.entryId,
      });
      await ctx.db.delete(mapping._id);
      if (ops.length < ACTIVITY_OPS_LIMIT) {
        ops.push({ label: mapping.entryKey, op: "remove" });
      } else {
        truncated = true;
      }
    }

    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: binding.schemaId,
    });
    const finishedAt = Date.now(),
      syncedAt = finishedAt,
      finalEntryCount = schema !== null ? (schema.entryCount ?? 0) : run.total - stale.length;
    await ctx.db.patch(binding._id, {
      lastReconciledAt: run.mode === "reconcile" ? syncedAt : binding.lastReconciledAt,
      lastSyncedAt: syncedAt,
      syncedEntryCount: finalEntryCount,
    });
    await ctx.db.insert("datasetActivity", {
      added: run.added,
      bindingId: binding._id,
      entryCount: finalEntryCount,
      kind: run.mode,
      ops: ops.slice(0, ACTIVITY_OPS_LIMIT),
      removed: stale.length,
      schemaId: binding.schemaId,
      syncedAt,
      truncated,
      updated: run.updated,
    });
    await ctx.db.patch(args.runId, {
      finishedAt,
      removed: stale.length,
      status: "completed",
    });

    await Promise.all(
      run.chunkStorageIds.map(async (storageId) => {
        try {
          await ctx.storage.delete(storageId);
        } catch {
          // Best-effort cleanup.
        }
      }),
    );
  },
});

export const markRunFailed = internalMutation({
  args: { error: v.string(), runId: v.id("syncRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status === "completed" || run.status === "failed") {
      return;
    }
    await ctx.db.patch(args.runId, {
      error: args.error,
      finishedAt: Date.now(),
      status: "failed",
    });
    await Promise.all(
      run.chunkStorageIds.map(async (storageId) => {
        try {
          await ctx.storage.delete(storageId);
        } catch {
          // Best-effort cleanup.
        }
      }),
    );
  },
});

/**
 * The weekly drift-repair sweep (the design's "periodically diff"): a full
 * reconcile pass per binding. Missed commits, out-of-band source edits, or
 * an outage during a sync all show up as key/map drift, which the keyed
 * apply repairs.
 */
export const reconcileAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bindings = await ctx.db.query("datasetBindings").collect();
    for (const binding of bindings) {
      // oxlint-disable-next-line no-await-in-loop -- one scheduled kickoff per binding.
      await ctx.scheduler.runAfter(0, internal.sync.reconcileOne, { source: binding.source });
    }
    return bindings.length;
  },
  returns: v.number(),
});

export const reconcileOne = internalMutation({
  args: { source: v.string() },
  handler: async (ctx, args) => startRunInternal(ctx, { mode: "reconcile", source: args.source }),
  returns: v.object({ alreadyRunning: v.boolean(), runId: v.id("syncRuns") }),
});

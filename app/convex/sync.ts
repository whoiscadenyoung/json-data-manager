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
import {
  chunkByJsonBytes,
  getSource,
  type CommitFeedEntry,
  type ProjectionRow,
  SOURCE_KEY,
} from "./sources";

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
  // The commit mirror keeps the newest N applied commits per binding
  // (finalizeRun prunes beyond this after every run).
  COMMIT_MIRROR_LIMIT = 200,
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
): Promise<{
  binding: { lastAppliedCommitSeq?: number };
  bindingId: Id<"datasetBindings">;
  schemaId: string;
}> {
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
    return { binding: {}, bindingId, schemaId };
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
  return { binding, bindingId: binding._id, schemaId };
}

async function startRunInternal(
  ctx: MutationCtx,
  args: { mode: "reconcile" | "sync"; source: string },
): Promise<{ alreadyRunning: boolean; runId: Id<"syncRuns"> }> {
  const source = getSource(args.source);
  const { binding, bindingId, schemaId } = await ensureBoundDataset(ctx, args.source);

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

  // Mode decision: "sync" prefers the design's primary path — the commit
  // tail since the binding's last-applied commit — whenever the source has a
  // commit feed and the binding has a keyed baseline. Full passes
  // re-baseline the cursor; "reconcile" always diffs full state.
  const tailEligible =
    args.mode === "sync" &&
    source.commitsSince !== undefined &&
    binding.lastAppliedCommitSeq !== undefined;
  const runMode: "commit-tail" | "reconcile" | "sync" = tailEligible ? "commit-tail" : args.mode;

  const runId = await ctx.db.insert("syncRuns", {
    added: 0,
    applied: 0,
    bindingId,
    chunkIndex: 0,
    chunkStorageIds: [],
    lastProgressAt: Date.now(),
    mode: runMode,
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
      mode: v.union(v.literal("commit-tail"), v.literal("reconcile"), v.literal("sync")),
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
  handler: async (ctx, args) => await getSource(args.source).listRows(ctx),
  returns: v.array(
    v.object({
      data: v.record(v.string(), v.any()),
      geometry: v.optional(v.any()),
      key: v.string(),
    }),
  ),
});

/** Reads one source's commit tail after `sinceSeq` — the §8.2 feed. */
export const readCommitTail = internalQuery({
  args: { sinceSeq: v.number(), source: v.string() },
  handler: async (ctx, args) => {
    const source = getSource(args.source);
    if (source.commitsSince === undefined) {
      return [];
    }
    return source.commitsSince(ctx, args.sinceSeq);
  },
  returns: v.array(
    v.object({
      at: v.number(),
      foreignCommitId: v.string(),
      message: v.string(),
      ops: v.array(
        v.object({
          entryKey: v.string(),
          fields: v.array(
            v.object({ after: v.optional(v.any()), before: v.optional(v.any()), name: v.string() }),
          ),
          geometryChanged: v.boolean(),
          op: v.union(v.literal("add"), v.literal("delete"), v.literal("update")),
        }),
      ),
      seq: v.number(),
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

    // Commit-tail runs transport the feed since the binding's cursor; full
    // runs transport the whole state and re-baseline the cursor to the
    // source's newest commit.
    let payload: CommitFeedEntry[] | ProjectionRow[], total: number, newest: CommitFeedEntry | null;
    if (run.mode === "commit-tail") {
      const binding = await ctx.runQuery(internal.sync.getBindingDoc, {
        bindingId: run.bindingId,
      });
      if (binding === null) {
        throw new Error("The binding vanished before the tail was read.");
      }
      newest = await ctx.runQuery(internal.sync.readNewestCommit, { source: args.source });
      payload = await ctx.runQuery(internal.sync.readCommitTail, {
        sinceSeq: binding.lastAppliedCommitSeq ?? 0,
        source: args.source,
      });
      total = payload.length;
    } else {
      payload = await ctx.runQuery(internal.sync.readSourceRows, {
        source: args.source,
      });
      newest = await ctx.runQuery(internal.sync.readNewestCommit, { source: args.source });
      total = payload.length;
    }

    // Store the collected state as chunk blobs. App storage (not the
    // component's — the apply action reads these back with its own
    // ctx.storage, and component blobs only resolve inside the component).
    const chunkStorageIds: Array<Id<"_storage">> = [];
    for (const chunk of chunkByJsonBytes<CommitFeedEntry | ProjectionRow>(payload)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential uploads keep action memory bounded, mirroring the importer.
      const storageId = await ctx.storage.store(
        new Blob([JSON.stringify(chunk)], { type: "application/json" }),
      );
      chunkStorageIds.push(storageId);
    }
    await ctx.runMutation(internal.sync.markCollected, {
      chunkStorageIds,
      lastCommitId: newest !== null ? newest.foreignCommitId : undefined,
      lastSeq: newest !== null ? newest.seq : undefined,
      runId: args.runId,
      total,
    });
    await ctx.scheduler.runAfter(0, internal.sync.applyChunks, { runId: args.runId });
    return null;
  },
});

/** Reads one source's newest commit, if its descriptor carries a feed. */
export const readNewestCommit = internalQuery({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    const source = getSource(args.source);
    return source.newestCommit === undefined ? null : source.newestCommit(ctx);
  },
  returns: v.union(
    v.null(),
    v.object({
      at: v.number(),
      foreignCommitId: v.string(),
      message: v.string(),
      ops: v.array(
        v.object({
          entryKey: v.string(),
          fields: v.array(
            v.object({ after: v.optional(v.any()), before: v.optional(v.any()), name: v.string() }),
          ),
          geometryChanged: v.boolean(),
          op: v.union(v.literal("add"), v.literal("delete"), v.literal("update")),
        }),
      ),
      seq: v.number(),
    }),
  ),
});

export const getBindingDoc = internalQuery({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) => ctx.db.get(args.bindingId),
  returns: v.any(),
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
    lastCommitId: v.optional(v.string()),
    lastSeq: v.optional(v.number()),
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
      lastCommitId: args.lastCommitId,
      lastProgressAt: Date.now(),
      lastSeq: args.lastSeq,
      rowOffset: 0,
      status: "applying",
      total: args.total,
    });
  },
});

// Commits are small (a few field-level ops each), so a tail batch carries
// many more of them than a full-run batch carries rows.
const APPLY_BATCH_COMMITS = 25;

export const applyChunks = internalAction({
  args: { runId: v.id("syncRuns") },
  handler: async (ctx, args): Promise<null> => {
    const run: {
      chunkIndex: number;
      chunkStorageIds: Array<Id<"_storage">>;
      mode: string;
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
        const items = JSON.parse(await blob.text()) as Array<Record<string, unknown>>;
        const startOffset = chunkIndex === run.chunkIndex ? run.rowOffset : 0;
        const batchSize = run.mode === "commit-tail" ? APPLY_BATCH_COMMITS : APPLY_BATCH_ROWS;
        for (let offset = startOffset; offset < items.length; offset += batchSize) {
          const batch = items.slice(offset, offset + batchSize),
            rowOffset = offset + batch.length;
          // oxlint-disable-next-line no-await-in-loop -- each batch's checkpoint depends on the previous one committing.
          if (run.mode === "commit-tail") {
            await ctx.runMutation(internal.sync.applyCommitsBatch, {
              chunkIndex,
              commits: batch as unknown as CommitFeedEntry[],
              rowOffset,
              runId: args.runId,
            });
          } else {
            await ctx.runMutation(internal.sync.applyRowsBatch, {
              chunkIndex,
              rowOffset,
              rows: batch as unknown as ProjectionRow[],
              runId: args.runId,
            });
          }
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
 * Applies one batch of commit-feed entries — the design's primary sync path
 * (§5). Each commit's ops apply by key through the map: `add` builds the
 * full entry from the ops' after-values (geometry rebuilt from the merged
 * data), `update` merges field deltas into the stored entry,
 * `delete` removes the entry and its map row. Every applied commit is
 * mirrored into the `commits` table — the History rail's and commit
 * overlays' data, kept host-side so the foreign app can prune its own log.
 */
export const applyCommitsBatch = internalMutation({
  args: {
    chunkIndex: v.number(),
    commits: v.array(
      v.object({
        at: v.number(),
        foreignCommitId: v.string(),
        message: v.string(),
        ops: v.array(
          v.object({
            entryKey: v.string(),
            fields: v.array(
              v.object({
                after: v.optional(v.any()),
                before: v.optional(v.any()),
                name: v.string(),
              }),
            ),
            geometryChanged: v.boolean(),
            op: v.union(v.literal("add"), v.literal("delete"), v.literal("update")),
          }),
        ),
        seq: v.number(),
      }),
    ),
    rowOffset: v.number(),
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
    const source = getSource(run.source);

    const ops = [...run.ops];
    let truncated = run.truncated;
    let added = 0,
      removed = 0,
      updated = 0;
    for (const commit of args.commits) {
      for (const op of commit.ops) {
        // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies inside one transaction.
        const mapping = await ctx.db
          .query("bindingEntries")
          .withIndex("by_binding", (q) =>
            q.eq("bindingId", run.bindingId).eq("entryKey", op.entryKey),
          )
          .first();

        if (op.op === "delete") {
          if (mapping !== null) {
            // oxlint-disable-next-line no-await-in-loop
            await ctx.runMutation(components.jsonCms.lib.deleteEntry, {
              boundWrite: "sync",
              entryId: mapping.entryId,
            });
            await ctx.db.delete(mapping._id);
          }
          removed += 1;
          if (ops.length < ACTIVITY_OPS_LIMIT) {
            ops.push({ label: opLabelFor(op), op: "remove" });
          } else {
            truncated = true;
          }
          continue;
        }

        // `add` builds the entry from the op's after-values; `update` merges
        // the deltas into what's stored. A `update` with no map row (a
        // missed earlier commit) degrades to an add of its after-state.
        const baseData: Record<string, unknown> = {};
        if (op.op === "update" && mapping !== null) {
          // oxlint-disable-next-line no-await-in-loop
          const existing = await ctx.runQuery(components.jsonCms.lib.getEntry, {
            entryId: mapping.entryId,
          });
          if (existing !== null && typeof existing.data === "object" && existing.data !== null) {
            for (const [name, value] of Object.entries(existing.data)) {
              baseData[name] = value;
            }
          }
        }
        for (const field of op.fields) {
          baseData[field.name] = field.after;
        }
        const geometryJson =
          source.buildGeometry === undefined ? undefined : source.buildGeometry(baseData);
        const geometry =
          geometryJson === undefined || geometryJson === null
            ? undefined
            : JSON.stringify(geometryJson);

        if (mapping === null) {
          // oxlint-disable-next-line no-await-in-loop
          const entryId: string = await ctx.runMutation(components.jsonCms.lib.createEntry, {
            boundWrite: "sync",
            data: baseData,
            geometry,
            schemaId: binding.schemaId,
          });
          await ctx.db.insert("bindingEntries", {
            bindingId: run.bindingId,
            entryId,
            entryKey: op.entryKey,
            seenRun: `commit:${commit.seq}`,
          });
          added += 1;
          if (ops.length < ACTIVITY_OPS_LIMIT) {
            ops.push({
              detail: detailFor(op),
              label: typeof baseData.label === "string" ? baseData.label : opLabelFor(op),
              op: "add",
            });
          } else {
            truncated = true;
          }
          continue;
        }

        // oxlint-disable-next-line no-await-in-loop
        await ctx.runMutation(components.jsonCms.lib.updateEntry, {
          boundWrite: "sync",
          data: baseData,
          entryId: mapping.entryId,
          geometry: op.geometryChanged ? geometry : undefined,
        });
        await ctx.db.patch(mapping._id, { seenRun: `commit:${commit.seq}` });
        updated += 1;
        if (ops.length < ACTIVITY_OPS_LIMIT) {
          ops.push({
            detail: detailFor(op),
            label: typeof baseData.label === "string" ? baseData.label : opLabelFor(op),
            op: "update",
          });
        } else {
          truncated = true;
        }
      }
      // The applied commit mirrors into the host's log — the History rail
      // and commit overlays read this, not the foreign app's feed.
      await ctx.db.insert("commits", {
        appliedAt: Date.now(),
        at: commit.at,
        bindingId: run.bindingId,
        foreignCommitId: commit.foreignCommitId,
        message: commit.message,
        ops: commit.ops,
        seq: commit.seq,
      });
    }

    await ctx.db.patch(args.runId, {
      added: run.added + added,
      applied: run.applied + args.commits.length,
      chunkIndex: args.chunkIndex,
      lastProgressAt: Date.now(),
      ops: ops.slice(0, ACTIVITY_OPS_LIMIT),
      removed: run.removed + removed,
      rowOffset: args.rowOffset,
      truncated,
      updated: run.updated + updated,
    });
  },
});

/** The op's own label: a label/name field value when present, else the key. */
function opLabelFor(op: {
  entryKey: string;
  fields: Array<{ after?: unknown; before?: unknown; name: string }>;
}): string {
  for (const field of op.fields) {
    if (field.name === "label" || field.name === "name") {
      if (typeof field.after === "string") {
        return field.after;
      }
      if (typeof field.before === "string") {
        return field.before;
      }
    }
  }
  return op.entryKey;
}

/** Field-level before→after detail for one commit op (History-tab format). */
function detailFor(op: {
  fields: Array<{ after?: unknown; before?: unknown; name: string }>;
}): string | undefined {
  const changes = op.fields
    .filter((field) => field.name !== "lat" && field.name !== "lng")
    .map(
      (field) => `${field.name}: ${JSON.stringify(field.before)} → ${JSON.stringify(field.after)}`,
    );
  return changes.length === 0 ? undefined : changes.join("; ");
}

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
        .withIndex("by_binding", (q) => q.eq("bindingId", run.bindingId).eq("entryKey", row.key))
        .first();
      const hasGeometry = row.geometry !== undefined && row.geometry !== null ? true : false;
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
 * Completes a run and stamps the binding. Full runs first sweep the key map
 * for keys the run never saw (source deletes, finally for free); tail runs
 * skip that — their commits carried the deletes explicitly. Both stamp the
 * binding's commit cursor (a full run re-baselines it to the newest commit
 * it observed), write the activity row, and clean up the chunk blobs.
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

    // Full modes count deletes from the sweep below; a tail run already
    // accumulated its deletes (applied ops) on the run doc — keep them.
    let removed = run.mode === "commit-tail" ? run.removed : 0;
    let ops = [...run.ops];
    let truncated = run.truncated;
    if (run.mode !== "commit-tail") {
      const mappings = await ctx.db
        .query("bindingEntries")
        .withIndex("by_binding", (q) => q.eq("bindingId", run.bindingId))
        .collect();
      const stale = mappings.filter((mapping) => mapping.seenRun !== args.runId);
      for (const mapping of stale) {
        // oxlint-disable-next-line no-await-in-loop -- ordered deletes under the transaction's write budget.
        await ctx.runMutation(components.jsonCms.lib.deleteEntry, {
          boundWrite: "sync",
          entryId: mapping.entryId,
        });
        await ctx.db.delete(mapping._id);
        removed += 1;
        if (ops.length < ACTIVITY_OPS_LIMIT) {
          ops.push({ label: mapping.entryKey, op: "remove" });
        } else {
          truncated = true;
        }
      }
    }

    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: binding.schemaId,
    });
    const finishedAt = Date.now(),
      syncedAt = finishedAt,
      finalEntryCount =
        schema !== null ? (schema.entryCount ?? 0) : Math.max(0, run.total - removed);
    await ctx.db.patch(binding._id, {
      lastAppliedCommitId: run.lastCommitId,
      lastAppliedCommitSeq: run.lastSeq,
      lastReconciledAt: run.mode === "reconcile" ? syncedAt : binding.lastReconciledAt,
      lastSyncedAt: syncedAt,
      syncedEntryCount: finalEntryCount,
    });
    await ctx.db.insert("datasetActivity", {
      added: run.added,
      bindingId: binding._id,
      entryCount: finalEntryCount,
      kind: run.mode === "reconcile" ? "reconcile" : "sync",
      ops: ops.slice(0, ACTIVITY_OPS_LIMIT),
      removed,
      schemaId: binding.schemaId,
      syncedAt,
      truncated,
      updated: run.updated,
    });
    await ctx.db.patch(args.runId, {
      finishedAt,
      removed,
      status: "completed",
    });

    // Keep the commit mirror bounded: the newest COMMIT_MIRROR_LIMIT rows
    // per binding stay; older mirrors are pruned (the foreign feed remains
    // the durable record, and the cursor still advances from it).
    let seenMirrors = 0;
    for await (const mirror of ctx.db
      .query("commits")
      .withIndex("by_binding_seq", (q) => q.eq("bindingId", run.bindingId))
      .order("desc")) {
      seenMirrors += 1;
      if (seenMirrors > COMMIT_MIRROR_LIMIT) {
        // oxlint-disable-next-line no-await-in-loop -- bounded pruning deletes.
        await ctx.db.delete(mirror._id);
      }
    }

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

/**
 * The applied-commit mirror for one binding, newest first — the dataset
 * History rail's data. Each row carries the foreign commit's message and
 * field-level ops, so selecting one can highlight exactly what it changed.
 */
export const listCommits = query({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) =>
    ctx.db
      .query("commits")
      .withIndex("by_binding_seq", (q) => q.eq("bindingId", args.bindingId))
      .order("desc")
      .take(50),
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("commits"),
      appliedAt: v.number(),
      at: v.number(),
      bindingId: v.id("datasetBindings"),
      foreignCommitId: v.string(),
      message: v.string(),
      ops: v.array(
        v.object({
          entryKey: v.string(),
          fields: v.array(
            v.object({ after: v.optional(v.any()), before: v.optional(v.any()), name: v.string() }),
          ),
          geometryChanged: v.boolean(),
          op: v.union(v.literal("add"), v.literal("delete"), v.literal("update")),
        }),
      ),
      seq: v.number(),
    }),
  ),
});

/**
 * The projection's key → feature map for one binding: the commit overlay's
 * lookup (a commit's ops name entries by foreign key; this resolves each key
 * to its current label and geometry-relevant data so the client can draw
 * what the commit touched). Bounded — this serves the demo-scale datasets.
 */
export const commitFeatureMap = query({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) => {
    const mappings = await ctx.db
      .query("bindingEntries")
      .withIndex("by_binding", (q) => q.eq("bindingId", args.bindingId))
      .take(2000);
    return Promise.all(
      mappings.map(async (mapping) => {
        const entry = await ctx.runQuery(components.jsonCms.lib.getEntry, {
          entryId: mapping.entryId,
        });
        const data =
          entry !== null && typeof entry.data === "object" && entry.data !== null
            ? (entry.data as Record<string, unknown>)
            : {};
        return {
          data,
          entryKey: mapping.entryKey,
          label:
            typeof data.label === "string"
              ? data.label
              : typeof data.name === "string"
                ? data.name
                : mapping.entryKey,
        };
      }),
    );
  },
  returns: v.array(
    v.object({
      data: v.record(v.string(), v.any()),
      entryKey: v.string(),
      label: v.string(),
    }),
  ),
});

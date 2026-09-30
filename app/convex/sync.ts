import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { auth } from "./auth";
import {
  chunkByJsonBytes,
  type CommitFeedEntry,
  COMMIT_TAIL_PAGE,
  getSource,
  type ProjectionRow,
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
 * 4. `finalizeRun` hands full modes to the batched sweep (`sweepStaleBatch`):
 *    stale keys — mappings the run never saw — are retired SWEEP_BATCH at a
 *    time, rescheduled until clean, and only then does the run complete
 *    (`completeRun`: stamps the binding, writes the activity row, prunes the
 *    commit mirror, cleans up the chunk blobs). Tail runs skip the sweep —
 *    their commits carried the deletes explicitly.
 *
 * Runs carry a lease (`claim`) minted at every schedule/revive: only the
 * lease holder may collect, apply, or finalize, so a revived run never has
 * two consumers (#127). Writes go through the component's public entry
 * mutations with the host-only `boundWrite` attestation (#75) — component
 * internals are not reachable from the host, and the read-only gate requires
 * the attestation.
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
  STALE_RUN_MS = 2 * 60 * 1000,
  // How many times one run's collect may be scheduled (initial + revives).
  // Past this the run is failed instead of revived again — a collect that
  // keeps dying must not be rescheduled forever (#127 defect 3).
  MAX_COLLECT_ATTEMPTS = 3,
  // Stale-mapping deletions per finalize-sweep batch (#127 defect 9): the
  // sweep resumes batch by batch instead of deleting a few thousand
  // projections in one transaction.
  SWEEP_BATCH = 100,
  // Mappings read per listEntriesForIds call in commitFeatureMap — the
  // component throws above 200 ids per batch (#127 defect 11).
  COMMIT_FEATURE_ID_BATCH = 200;

/**
 * A per-scheduling lease token (#127 defect 7): minted when a run is created
 * or revived, stored on the run doc, and checked by markCollected and every
 * apply/finalize mutation. A superseded action (its claim rotated away)
 * can neither win the collect, apply a batch, nor finalize — one consumer
 * per run, always. Same mint as publish.ts's ids (getRandomValues when the
 * runtime has it, Math.random fallback otherwise).
 */
function newClaimToken(): string {
  return typeof crypto !== "undefined" && crypto.getRandomValues !== undefined
    ? crypto.getRandomValues(new Uint32Array(4)).reduce((acc, word) => acc + word.toString(36), "")
    : `${Date.now()}-${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
}

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

/** One History/commit-rail activity entry — the run doc's `ops` items. */
interface ActivityOp {
  detail?: string;
  label: string;
  op: "add" | "remove" | "update";
}

/** Running tallies for one apply batch — mutated in place inside the batch's transaction. */
interface BatchTally {
  added: number;
  // True when a commit op could not be applied from the tail alone (an
  // `update` whose foreign key had no projection mapping) — completion
  // schedules a reconcile to repair it (#127 defect 6).
  needsReconcile: boolean;
  ops: ActivityOp[];
  removed: number;
  truncated: boolean;
  updated: number;
}

/** Appends an activity op until the cap, then just marks the run truncated. */
function recordActivity(tally: BatchTally, entry: ActivityOp): void {
  if (tally.ops.length < ACTIVITY_OPS_LIMIT) {
    tally.ops.push(entry);
  } else {
    tally.truncated = true;
  }
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

/**
 * First engine run over a pre-engine projection: its rows predate the key
 * map, so a keyed apply would leave them as unmanaged strays. Clear them
 * once; the keyed apply then repopulates from scratch. (`.first()` resolves
 * to NULL, not undefined, on an empty index — the same trap the auth gate
 * hit.)
 */
async function clearPreEngineStrays(
  ctx: MutationCtx,
  bindingId: Id<"datasetBindings">,
  schemaId: string,
): Promise<void> {
  const existingMapping = await ctx.db
    .query("bindingEntries")
    .withIndex("by_binding", (q) => q.eq("bindingId", bindingId))
    .first();
  if (existingMapping !== null) {
    return;
  }
  const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  if (schema !== null && (schema.entryCount ?? 0) > 0) {
    await ctx.runMutation(components.jsonCms.lib.deleteEntriesBySchema, {
      boundWrite: "sync",
      schemaId,
    });
  }
}

/**
 * Revives one stale collecting run: rotate the lease, count the attempt, and
 * give up (fail the run) once the attempt budget is spent (#127 defect 3).
 */
async function reviveCollectingRun(
  ctx: MutationCtx,
  lastRun: Doc<"syncRuns">,
  source: string,
): Promise<Id<"syncRuns"> | null> {
  const attempts = (lastRun.collectAttempts ?? 1) + 1;
  if (attempts > MAX_COLLECT_ATTEMPTS) {
    await ctx.db.patch(lastRun._id, {
      error: `Collect was scheduled ${lastRun.collectAttempts ?? 1} times without completing; giving up on this run.`,
      finishedAt: Date.now(),
      status: "failed",
    });
    return null;
  }
  const claim = newClaimToken();
  await ctx.db.patch(lastRun._id, {
    claim,
    collectAttempts: attempts,
    lastProgressAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.sync.collectRows, {
    claim,
    runId: lastRun._id,
    source,
  });
  return lastRun._id;
}

/** Revives one stale applying run: rotate the lease and reschedule the apply. */
async function reviveApplyingRun(
  ctx: MutationCtx,
  lastRun: Doc<"syncRuns">,
): Promise<Id<"syncRuns">> {
  const claim = newClaimToken();
  await ctx.db.patch(lastRun._id, { claim, lastProgressAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.sync.applyChunks, { claim, runId: lastRun._id });
  return lastRun._id;
}

/**
 * An active run joins instead of forking a second one. A run whose
 * checkpoint went quiet is dead (its action was lost); the checkpoint makes
 * resuming it safe, which is the durability the engine exists for. Each
 * revive rotates the run's claim token — the lease (#127 defect 7) — so a
 * long collect that was wrongly suspected dead cannot win `markCollected`
 * against the fresh attempt, and a collect past its attempt budget is
 * failed rather than revived forever (#127 defect 3). A `sweeping` run is
 * scheduler-driven (each batch schedules the next); it only joins. Returns
 * the live run's id, or null when none exists (or the run was given up on).
 */
async function joinOrReviveActiveRun(
  ctx: MutationCtx,
  bindingId: Id<"datasetBindings">,
  source: string,
): Promise<Id<"syncRuns"> | null> {
  const lastRun = await ctx.db
    .query("syncRuns")
    .withIndex("by_binding", (q) => q.eq("bindingId", bindingId))
    .order("desc")
    .first();
  if (
    lastRun === null ||
    (lastRun.status !== "applying" &&
      lastRun.status !== "collecting" &&
      lastRun.status !== "sweeping")
  ) {
    return null;
  }
  if (lastRun.status === "sweeping" || Date.now() - lastRun.lastProgressAt < STALE_RUN_MS) {
    return lastRun._id;
  }
  if (lastRun.status === "collecting") {
    return reviveCollectingRun(ctx, lastRun, source);
  }
  return reviveApplyingRun(ctx, lastRun);
}

async function startRunInternal(
  ctx: MutationCtx,
  args: { mode: "reconcile" | "sync"; source: string },
): Promise<{ alreadyRunning: boolean; runId: Id<"syncRuns"> }> {
  const source = getSource(args.source);
  // The active-run check runs BEFORE any binding write: patching the
  // binding first (the old order) raced a concurrently-finalizing run, which
  // also stamps the binding — every kickoff paid an OCC conflict (#127
  // defect 11).
  const existingBinding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_source", (q) => q.eq("source", args.source))
    .first();
  if (existingBinding !== null) {
    const activeRunId = await joinOrReviveActiveRun(ctx, existingBinding._id, args.source);
    if (activeRunId !== null) {
      return { alreadyRunning: true, runId: activeRunId };
    }
  }

  const { binding, bindingId, schemaId } = await ensureBoundDataset(ctx, args.source);
  await clearPreEngineStrays(ctx, bindingId, schemaId);

  // Mode decision: "sync" prefers the design's primary path — the commit
  // tail since the binding's last-applied commit — whenever the source has a
  // commit feed and the binding has a keyed baseline. Full passes
  // re-baseline the cursor; "reconcile" always diffs full state.
  const tailEligible =
    args.mode === "sync" &&
    source.commitsSince !== undefined &&
    binding.lastAppliedCommitSeq !== undefined;
  const runMode: "commit-tail" | "reconcile" | "sync" = tailEligible ? "commit-tail" : args.mode;

  const claim = newClaimToken();
  const runId = await ctx.db.insert("syncRuns", {
    added: 0,
    applied: 0,
    bindingId,
    chunkIndex: 0,
    chunkStorageIds: [],
    claim,
    collectAttempts: 1,
    lastProgressAt: Date.now(),
    mode: runMode,
    needsReconcile: false,
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
    claim,
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
  handler: async (ctx, args) => {
    await auth(ctx);
    return startRunInternal(ctx, args);
  },
  returns: v.object({
    alreadyRunning: v.boolean(),
    runId: v.id("syncRuns"),
  }),
});

/** The latest run for one source, for the dashboard's live progress row. */
export const latestRun = query({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
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
      needsReconcile: run.needsReconcile,
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
      needsReconcile: v.optional(v.boolean()),
      removed: v.number(),
      startedAt: v.number(),
      status: v.union(
        v.literal("applying"),
        v.literal("collecting"),
        v.literal("sweeping"),
        v.literal("completed"),
        v.literal("failed"),
      ),
      total: v.number(),
      updated: v.number(),
    }),
  ),
});

/** Reads one page of a source's state — the action-side bridge to its descriptor. Callers drain pages until the null cursor (#127 defect 1). */
export const readSourceRows = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), source: v.string() },
  handler: async (ctx, args) => getSource(args.source).listRows(ctx, args.cursor),
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    rows: v.array(
      v.object({
        data: v.record(v.string(), v.any()),
        geometry: v.optional(v.any()),
        key: v.string(),
      }),
    ),
  }),
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

/** What a collect leg produced: the chunk blobs, the row/commit total, and the cursor it ends on. */
interface CollectedPayload {
  chunkStorageIds: Array<Id<"_storage">>;
  cursorCommitId?: string;
  cursorSeq?: number;
  total: number;
}

/** Stores one parsed chunk as an app-storage blob (see collectRows' storage note). */
async function storeChunk(
  ctx: ActionCtx,
  chunkStorageIds: Array<Id<"_storage">>,
  chunk: unknown,
): Promise<void> {
  const storageId = await ctx.storage.store(
    new Blob([JSON.stringify(chunk)], { type: "application/json" }),
  );
  chunkStorageIds.push(storageId);
}

/**
 * The commit-tail leg: drains the feed page by page since the binding's
 * cursor — a tail past the page size drains fully (#127 defect 2) — and
 * ends on the payload's last commit, never `newestCommit()`, which used to
 * skip past commits the capped read never carried.
 */
async function collectCommitTail(
  ctx: ActionCtx,
  args: { bindingId: Id<"datasetBindings">; source: string },
): Promise<CollectedPayload> {
  const binding = await ctx.runQuery(internal.sync.getBindingDoc, { bindingId: args.bindingId });
  if (binding === null) {
    throw new Error("The binding vanished before the tail was read.");
  }
  const payload: CollectedPayload = { chunkStorageIds: [], total: 0 };
  let sinceSeq = binding.lastAppliedCommitSeq ?? 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- paging the tail; a short page ends the drain.
    const page: CommitFeedEntry[] = await ctx.runQuery(internal.sync.readCommitTail, {
      sinceSeq,
      source: args.source,
    });
    for (const chunk of chunkByJsonBytes<CommitFeedEntry>(page)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential uploads keep action memory bounded, mirroring the importer.
      await storeChunk(ctx, payload.chunkStorageIds, chunk);
    }
    payload.total += page.length;
    const last = page[page.length - 1];
    if (last !== undefined) {
      payload.cursorCommitId = last.foreignCommitId;
      payload.cursorSeq = last.seq;
    }
    if (page.length < COMMIT_TAIL_PAGE) {
      break;
    }
    sinceSeq = payload.cursorSeq ?? sinceSeq;
  }
  return payload;
}

/**
 * The full-state leg: reads the newest commit BEFORE the rows — a commit
 * landing between the two reads is then covered by the rows but not the
 * cursor (harmless, idempotent), never stamped as applied while missing
 * from them (#127 defect 5) — and drains the state page by page across
 * transactions until the null cursor, so a truncated read can never reach
 * finalize's sweep (#127 defect 1).
 */
async function collectFullState(ctx: ActionCtx, source: string): Promise<CollectedPayload> {
  const newest = await ctx.runQuery(internal.sync.readNewestCommit, { source });
  const payload: CollectedPayload = { chunkStorageIds: [], total: 0 };
  let rowsCursor: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- paging across transactions; the null cursor ends the drain.
    const page: { cursor: string | null; rows: ProjectionRow[] } = await ctx.runQuery(
      internal.sync.readSourceRows,
      { cursor: rowsCursor, source },
    );
    for (const chunk of chunkByJsonBytes<ProjectionRow>(page.rows)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential uploads keep action memory bounded, mirroring the importer.
      await storeChunk(ctx, payload.chunkStorageIds, chunk);
    }
    payload.total += page.rows.length;
    if (page.cursor === null) {
      break;
    }
    rowsCursor = page.cursor;
  }
  payload.cursorCommitId = newest !== null ? newest.foreignCommitId : undefined;
  payload.cursorSeq = newest !== null ? newest.seq : undefined;
  return payload;
}

export const collectRows = internalAction({
  args: { claim: v.string(), runId: v.id("syncRuns"), source: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.runQuery(internal.sync.getRunDoc, { runId: args.runId });
    if (run === null || run.status !== "collecting" || run.claim !== args.claim) {
      // A superseded collect (its lease was rotated by a revive) does
      // nothing — the fresh attempt owns the run (#127 defect 7).
      return null;
    }

    try {
      // App storage (not the component's — the apply action reads these
      // back with its own ctx.storage, and component blobs only resolve
      // inside the component).
      const payload =
        run.mode === "commit-tail"
          ? await collectCommitTail(ctx, { bindingId: run.bindingId, source: args.source })
          : await collectFullState(ctx, args.source);

      const won = await ctx.runMutation(internal.sync.markCollected, {
        claim: args.claim,
        chunkStorageIds: payload.chunkStorageIds,
        lastCommitId: payload.cursorCommitId,
        lastSeq: payload.cursorSeq,
        runId: args.runId,
        total: payload.total,
      });
      if (!won) {
        // The lease was rotated while this collect ran; markCollected
        // deleted this attempt's blobs and the fresh attempt owns the run —
        // schedule nothing (#127 defect 7).
        return null;
      }
      await ctx.scheduler.runAfter(0, internal.sync.applyChunks, {
        claim: args.claim,
        runId: args.runId,
      });
      return null;
    } catch (error) {
      // A failed collect used to strand the run in `collecting` forever
      // (revives kept rescheduling the same failing collect) — fail it
      // cleanly instead (#127 defect 3).
      await ctx.runMutation(internal.sync.markRunFailed, {
        error: error instanceof Error ? error.message : "Sync collect failed.",
        runId: args.runId,
      });
      return null;
    }
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
    claim: v.string(),
    chunkStorageIds: v.array(v.id("_storage")),
    lastCommitId: v.optional(v.string()),
    lastSeq: v.optional(v.number()),
    runId: v.id("syncRuns"),
    total: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status !== "collecting" || run.claim !== args.claim) {
      // This attempt lost the lease (a revive rotated the claim, or the run
      // moved on): delete the blobs THIS attempt stored so they don't leak,
      // and report the loss — the caller schedules nothing (#127 defect 7).
      if (run !== null) {
        await Promise.all(
          args.chunkStorageIds.map(async (storageId) => {
            try {
              await ctx.storage.delete(storageId);
            } catch {
              // Best-effort cleanup.
            }
          }),
        );
      }
      return false;
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
    return true;
  },
});

/**
 * The checkpoint fields for one batch's run patch — empty when the batch
 * would move the resume point backwards: the checkpoint only ever advances,
 * so a superseded action replaying an older batch cannot drag it back
 * (#127 defect 7).
 */
function checkpointFields(
  run: { chunkIndex: number; rowOffset: number },
  chunkIndex: number,
  rowOffset: number,
): { chunkIndex?: number; rowOffset?: number } {
  const advances =
    chunkIndex > run.chunkIndex || (chunkIndex === run.chunkIndex && rowOffset >= run.rowOffset);
  return advances ? { chunkIndex, rowOffset } : {};
}

// Commits are small (a few field-level ops each), so a tail batch carries
// many more of them than a full-run batch carries rows.
const APPLY_BATCH_COMMITS = 25;

/**
 * Applies one parsed chunk's items in batches from `startOffset`, calling
 * the mode's batch mutation and checkpointing the run after each batch. The
 * lease rides along so every batch re-verifies it still owns the run.
 */
async function applyChunkBatches(
  ctx: ActionCtx,
  runId: Id<"syncRuns">,
  run: { chunkIndex: number; mode: string },
  claim: string,
  chunkIndex: number,
  items: Array<Record<string, unknown>>,
  startOffset: number,
): Promise<void> {
  const batchSize = run.mode === "commit-tail" ? APPLY_BATCH_COMMITS : APPLY_BATCH_ROWS;
  for (let offset = startOffset; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize),
      rowOffset = offset + batch.length;
    if (run.mode === "commit-tail") {
      // oxlint-disable-next-line no-await-in-loop -- each batch's checkpoint depends on the previous one committing.
      await ctx.runMutation(internal.sync.applyCommitsBatch, {
        claim,
        chunkIndex,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the batch entries are re-validated by applyCommitsBatch's args validator.
        commits: batch as unknown as CommitFeedEntry[],
        rowOffset,
        runId,
      });
    } else {
      // oxlint-disable-next-line no-await-in-loop -- checkpoint chain; each batch's checkpoint depends on the previous one committing.
      await ctx.runMutation(internal.sync.applyRowsBatch, {
        claim,
        chunkIndex,
        rowOffset,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows are re-validated by applyRowsBatch's args validator.
        rows: batch as unknown as ProjectionRow[],
        runId,
      });
    }
  }
}

export const applyChunks = internalAction({
  args: { claim: v.string(), runId: v.id("syncRuns") },
  handler: async (ctx, args): Promise<null> => {
    const run: {
      claim?: string;
      chunkIndex: number;
      chunkStorageIds: Array<Id<"_storage">>;
      mode: string;
      rowOffset: number;
      status: string;
    } | null = await ctx.runQuery(internal.sync.getRunDoc, { runId: args.runId });
    if (run === null || run.status !== "applying" || run.claim !== args.claim) {
      // A superseded action (lease rotated by a revive) neither applies nor
      // finalizes — one consumer per run (#127 defect 7).
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
        // oxlint-disable-next-line no-await-in-loop, typescript/no-unsafe-type-assertion -- ordered chunks; the JSON was written by collectRows from the source's own typed rows.
        const items = JSON.parse(await blob.text()) as Array<Record<string, unknown>>;
        const startOffset = chunkIndex === run.chunkIndex ? run.rowOffset : 0;
        // oxlint-disable-next-line no-await-in-loop -- chunks apply in order; the checkpoint depends on it.
        await applyChunkBatches(ctx, args.runId, run, args.claim, chunkIndex, items, startOffset);
      }
      await ctx.runMutation(internal.sync.finalizeRun, { claim: args.claim, runId: args.runId });
    } catch (error) {
      await ctx.runMutation(internal.sync.markRunFailed, {
        error: error instanceof Error ? error.message : "Sync failed.",
        runId: args.runId,
      });
    }
    return null;
  },
});

/** The stored entry data an `update` op merges into: whatever the entry currently holds. */
async function existingEntryData(
  ctx: MutationCtx,
  entryId: string,
): Promise<Record<string, unknown>> {
  // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies inside one transaction.
  const existing = await ctx.runQuery(components.jsonCms.lib.getEntry, { entryId });
  const baseData: Record<string, unknown> = {};
  if (existing !== null && typeof existing.data === "object" && existing.data !== null) {
    for (const [name, value] of Object.entries(existing.data)) {
      baseData[name] = value;
    }
  }
  return baseData;
}

/** Serializes a commit op's derived geometry, or undefined when the source builds none from data. */
function commitGeometry(
  source: ReturnType<typeof getSource>,
  baseData: Record<string, unknown>,
): string | undefined {
  const geometryJson =
    source.buildGeometry === undefined ? undefined : source.buildGeometry(baseData);
  return geometryJson === undefined || geometryJson === null
    ? undefined
    : JSON.stringify(geometryJson);
}

/** Applies a commit's `delete` op: drops the mapped entry and counts it. A delete for an already-unmapped key is a projection no-op. */
async function applyDeleteOp(
  ctx: MutationCtx,
  args: {
    mapping: Doc<"bindingEntries"> | null;
    op: { entryKey: string; fields: Array<{ after?: unknown; before?: unknown; name: string }> };
    tally: BatchTally;
  },
): Promise<void> {
  const { mapping, tally } = args;
  if (mapping === null) {
    return;
  }
  // oxlint-disable-next-line no-await-in-loop -- ordered deletes under the transaction's write budget.
  await ctx.runMutation(components.jsonCms.lib.deleteEntry, {
    boundWrite: "sync",
    entryId: mapping.entryId,
  });
  await ctx.db.delete(mapping._id);
  tally.removed += 1;
  recordActivity(tally, { label: opLabelFor(args.op), op: "remove" });
}

/**
 * Applies one commit op to its keyed entry, recording the activity entry and
 * the counters (#127 defect 4): `delete` drops the entry and its map row
 * (counted removed; a delete for an already-unmapped key is a no-op), `add`
 * builds the entry from the op's after-values (geometry rebuilt from the
 * merged data; counted added), and `update` merges the field deltas into
 * what's stored (counted updated). An `update` whose key has no map row is
 * NOT applied — commit updates carry only the changed columns, so
 * materializing one would create a partial entry — the run is flagged
 * `needsReconcile` and completion schedules a full pass to repair the key
 * from full state (#127 defect 6).
 */
async function applyCommitOp(
  ctx: MutationCtx,
  args: {
    binding: Doc<"datasetBindings">;
    commitSeq: number;
    op: {
      entryKey: string;
      fields: Array<{ after?: unknown; name: string }>;
      geometryChanged: boolean;
      op: "add" | "delete" | "update";
    };
    source: ReturnType<typeof getSource>;
    tally: BatchTally;
  },
): Promise<void> {
  const { op, tally } = args;
  // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies inside one transaction.
  const mapping = await ctx.db
    .query("bindingEntries")
    .withIndex("by_binding", (q) => q.eq("bindingId", args.binding._id).eq("entryKey", op.entryKey))
    .first();

  if (op.op === "delete") {
    await applyDeleteOp(ctx, { mapping, op, tally });
    return;
  }

  // `add` builds the entry from the op's after-values; `update` merges
  // the deltas into what's stored.
  if (op.op === "update" && mapping === null) {
    // Never materialize a partial entry from a delta-only op — flag the
    // run so completion schedules a full reconcile (#127 defect 6).
    tally.needsReconcile = true;
    recordActivity(tally, {
      detail: "Key not in the projection — a full reconcile was scheduled to restore it.",
      label: opLabelFor(op),
      op: "update",
    });
    return;
  }
  const baseData =
    op.op === "update" && mapping !== null ? await existingEntryData(ctx, mapping.entryId) : {};
  for (const field of op.fields) {
    baseData[field.name] = field.after;
  }
  const geometry = commitGeometry(args.source, baseData);
  const label = typeof baseData.label === "string" ? baseData.label : opLabelFor(op);

  if (mapping === null) {
    // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies inside one transaction.
    const entryId: string = await ctx.runMutation(components.jsonCms.lib.createEntry, {
      boundWrite: "sync",
      data: baseData,
      geometry,
      schemaId: args.binding.schemaId,
    });
    await ctx.db.insert("bindingEntries", {
      bindingId: args.binding._id,
      entryId,
      entryKey: op.entryKey,
      seenRun: `commit:${args.commitSeq}`,
    });
    tally.added += 1;
    recordActivity(tally, { detail: detailFor(op), label, op: "add" });
    return;
  }

  // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies inside one transaction.
  await ctx.runMutation(components.jsonCms.lib.updateEntry, {
    boundWrite: "sync",
    data: baseData,
    entryId: mapping.entryId,
    geometry: op.geometryChanged ? geometry : undefined,
  });
  await ctx.db.patch(mapping._id, { seenRun: `commit:${args.commitSeq}` });
  tally.updated += 1;
  recordActivity(tally, { detail: detailFor(op), label, op: "update" });
}

/**
 * Mirrors one applied commit into the host's log — the History rail's and
 * commit overlays' data. The (bindingId, seq) check keeps a replayed tail
 * from duplicating rows a partially failed run already mirrored (#127
 * defect 8).
 */
async function mirrorAppliedCommit(
  ctx: MutationCtx,
  bindingId: Id<"datasetBindings">,
  commit: { at: number; foreignCommitId: string; message: string; seq: number } & {
    ops: Array<{
      entryKey: string;
      fields: Array<{ after?: unknown; before?: unknown; name: string }>;
      geometryChanged: boolean;
      op: "add" | "delete" | "update";
    }>;
  },
): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- sequential mirror inserts under the transaction's write budget.
  const existingMirror = await ctx.db
    .query("commits")
    .withIndex("by_binding_seq", (q) => q.eq("bindingId", bindingId).eq("seq", commit.seq))
    .first();
  if (existingMirror !== null) {
    return;
  }
  // oxlint-disable-next-line no-await-in-loop -- sequential mirror inserts under the transaction's write budget.
  await ctx.db.insert("commits", {
    appliedAt: Date.now(),
    at: commit.at,
    bindingId,
    foreignCommitId: commit.foreignCommitId,
    message: commit.message,
    ops: commit.ops,
    seq: commit.seq,
  });
}

/**
 * Applies one batch of commit-feed entries — the design's primary sync path
 * (§5). Each commit's ops apply by key through the map (see `applyCommitOp`).
 * Every applied commit is mirrored into the `commits` table — the History
 * rail's and commit overlays' data, kept host-side so the foreign app can
 * prune its own log.
 */
export const applyCommitsBatch = internalMutation({
  args: {
    claim: v.string(),
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
    if (run === null || run.status !== "applying" || run.claim !== args.claim) {
      // Lost the lease or left the applying phase — apply nothing.
      return;
    }
    const binding = await ctx.db.get(run.bindingId);
    if (binding === null) {
      throw new ConvexError("The binding vanished mid-sync.");
    }
    const source = getSource(run.source);

    const tally: BatchTally = {
      added: 0,
      needsReconcile: run.needsReconcile ?? false,
      ops: [...run.ops],
      removed: 0,
      truncated: run.truncated,
      updated: 0,
    };
    for (const commit of args.commits) {
      for (const op of commit.ops) {
        // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies inside one transaction.
        await applyCommitOp(ctx, { binding, commitSeq: commit.seq, op, source, tally });
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential mirror inserts under the transaction's write budget.
      await mirrorAppliedCommit(ctx, run.bindingId, commit);
    }

    await ctx.db.patch(args.runId, {
      added: run.added + tally.added,
      applied: run.applied + args.commits.length,
      ...checkpointFields(run, args.chunkIndex, args.rowOffset),
      lastProgressAt: Date.now(),
      needsReconcile: tally.needsReconcile,
      ops: tally.ops.slice(0, ACTIVITY_OPS_LIMIT),
      removed: run.removed + tally.removed,
      truncated: tally.truncated,
      updated: run.updated + tally.updated,
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

/** True when the stored geometry no longer matches the row's geometry payload. */
function rowGeometryChanged(
  geometry: { geometryJson?: string } | null,
  hasGeometry: boolean,
  geometryJson: string | undefined,
): boolean {
  return geometry === null
    ? hasGeometry
    : !hasGeometry || geometry.geometryJson === undefined || geometry.geometryJson !== geometryJson;
}

/**
 * The `geometry` argument for an entry update: the new geometry when the
 * row has one, `null` (clear it) when the row lost its geometry, and
 * `undefined` (leave untouched) when there was nothing stored and nothing
 * to store.
 */
function geometryUpdateArg(
  row: { geometry?: unknown },
  hasStoredGeometry: boolean,
  geometryJson: string | undefined,
): string | null | undefined {
  if (row.geometry === undefined || row.geometry === null) {
    return hasStoredGeometry ? null : undefined;
  }
  return geometryJson;
}

/**
 * Applies one source row by key: a key with no map row inserts (entry +
 * map row), a dangling map row gets its entry rebuilt, and a mapped key
 * patches only when its content actually changed. Every map row is stamped
 * with the run so `finalizeRun` can detect deletes.
 */
async function applyRow(
  ctx: MutationCtx,
  args: {
    binding: Doc<"datasetBindings">;
    runId: Id<"syncRuns">;
    row: ProjectionRow;
    tally: BatchTally;
  },
): Promise<void> {
  const { row } = args;
  // oxlint-disable-next-line no-await-in-loop -- sequential keyed applies; each write feeds the next read in this transaction.
  const mapping = await ctx.db
    .query("bindingEntries")
    .withIndex("by_binding", (q) => q.eq("bindingId", args.binding._id).eq("entryKey", row.key))
    .first();
  const hasGeometry = row.geometry !== undefined && row.geometry !== null;
  const geometryJson = hasGeometry ? JSON.stringify(row.geometry) : undefined;

  if (mapping === null) {
    // oxlint-disable-next-line no-await-in-loop
    const entryId: string = await ctx.runMutation(components.jsonCms.lib.createEntry, {
      boundWrite: "sync",
      data: row.data,
      geometry: geometryJson,
      schemaId: args.binding.schemaId,
    });
    await ctx.db.insert("bindingEntries", {
      bindingId: args.binding._id,
      entryId,
      entryKey: row.key,
      seenRun: args.runId,
    });
    args.tally.added += 1;
    recordActivity(args.tally, { label: rowLabel(row), op: "add" });
    return;
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
      schemaId: args.binding.schemaId,
    });
    await ctx.db.patch(mapping._id, { entryId, seenRun: args.runId });
    args.tally.added += 1;
    recordActivity(args.tally, { label: rowLabel(row), op: "add" });
    return;
  }

  const dataChanged = JSON.stringify(entry.data) !== JSON.stringify(row.data);
  // oxlint-disable-next-line no-await-in-loop
  const geometry = await ctx.runQuery(components.jsonCms.lib.getEntryGeometry, {
    entryId: mapping.entryId,
  });
  if (dataChanged || rowGeometryChanged(geometry, hasGeometry, geometryJson)) {
    // oxlint-disable-next-line no-await-in-loop
    await ctx.runMutation(components.jsonCms.lib.updateEntry, {
      boundWrite: "sync",
      data: row.data,
      entryId: mapping.entryId,
      geometry: geometryUpdateArg(row, geometry !== null, geometryJson),
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- entries store object data; the ?? only covers a legacy null.
    const before = (entry.data ?? {}) as Record<string, unknown>;
    recordActivity(args.tally, {
      detail: dataChanged ? diffRowDetail(before, row.data) : undefined,
      label: rowLabel(row),
      op: "update",
    });
    args.tally.updated += 1;
  }
  // Unchanged rows still stamp the map with the run so delete
  // detection sees them as alive.
  await ctx.db.patch(mapping._id, { seenRun: args.runId });
}

/**
 * Applies one batch of source rows, keyed and idempotently. The checkpoint
 * (`chunkIndex`/`rowOffset`) lands in the same transaction as the writes,
 * so a crash can resume without duplicating or skipping a row.
 */
export const applyRowsBatch = internalMutation({
  args: {
    claim: v.string(),
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
    if (run === null || run.status !== "applying" || run.claim !== args.claim) {
      // Lost the lease or left the applying phase — apply nothing.
      return;
    }
    const binding = await ctx.db.get(run.bindingId);
    if (binding === null) {
      throw new ConvexError("The binding vanished mid-sync.");
    }

    const tally: BatchTally = {
      added: 0,
      needsReconcile: run.needsReconcile ?? false,
      ops: [...run.ops],
      removed: 0,
      truncated: run.truncated,
      updated: 0,
    };
    for (const row of args.rows) {
      // oxlint-disable-next-line no-await-in-loop -- rows apply sequentially; each keyed write feeds the next read in this transaction.
      await applyRow(ctx, { binding, row, runId: args.runId, tally });
    }

    await ctx.db.patch(args.runId, {
      added: run.added + tally.added,
      applied: run.applied + args.rows.length,
      ...checkpointFields(run, args.chunkIndex, args.rowOffset),
      lastProgressAt: Date.now(),
      needsReconcile: tally.needsReconcile,
      ops: tally.ops.slice(0, ACTIVITY_OPS_LIMIT),
      truncated: tally.truncated,
      updated: run.updated + tally.updated,
    });
  },
});

/**
 * Reads and retires up to SWEEP_BATCH stale mappings — keys the run never
 * saw, i.e. source deletes. The JS predicate keeps the exact
 * `seenRun !== runId` semantics (an undefined seenRun is stale too); the
 * scan stays inside the calling transaction exactly like the pre-batching
 * collect did. Returns the batch's ops/count via the tally.
 */
async function deleteStaleBatch(
  ctx: MutationCtx,
  bindingId: Id<"datasetBindings">,
  runId: Id<"syncRuns">,
  tally: BatchTally,
): Promise<number> {
  const stale: Array<Doc<"bindingEntries">> = [];
  for await (const mapping of ctx.db
    .query("bindingEntries")
    .withIndex("by_binding", (q) => q.eq("bindingId", bindingId))) {
    if (mapping.seenRun !== runId) {
      stale.push(mapping);
      if (stale.length === SWEEP_BATCH) {
        break;
      }
    }
  }
  for (const mapping of stale) {
    // oxlint-disable-next-line no-await-in-loop -- ordered deletes under the transaction's write budget.
    await ctx.runMutation(components.jsonCms.lib.deleteEntry, {
      boundWrite: "sync",
      entryId: mapping.entryId,
    });
    // oxlint-disable-next-line no-await-in-loop -- ordered deletes under the transaction's write budget.
    await ctx.db.delete(mapping._id);
    tally.removed += 1;
    recordActivity(tally, { label: mapping.entryKey, op: "remove" });
  }
  return stale.length;
}

/**
 * One bounded batch of the finalize sweep (full modes): retires stale
 * mappings SWEEP_BATCH at a time, then reschedules itself until the key map
 * is clean. Only when nothing stale remains does the run complete. The old
 * single-transaction sweep (collect every mapping, delete every stale one
 * inline) blew past the transaction limits at a few thousand removals
 * (#127 defect 9).
 */
export const sweepStaleBatch = internalMutation({
  args: { runId: v.id("syncRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status !== "sweeping") {
      return;
    }
    try {
      const binding = await ctx.db.get(run.bindingId);
      if (binding === null) {
        throw new ConvexError("The binding vanished mid-sync.");
      }
      const tally: BatchTally = {
        added: 0,
        needsReconcile: run.needsReconcile ?? false,
        ops: [...run.ops],
        removed: 0,
        truncated: run.truncated,
        updated: 0,
      };
      const removed = await deleteStaleBatch(ctx, run.bindingId, args.runId, tally);

      await ctx.db.patch(args.runId, {
        lastProgressAt: Date.now(),
        needsReconcile: tally.needsReconcile,
        ops: tally.ops.slice(0, ACTIVITY_OPS_LIMIT),
        removed: run.removed + tally.removed,
        truncated: tally.truncated,
      });
      if (removed === SWEEP_BATCH) {
        // The batch came back full — there may be more; resume in a fresh
        // transaction.
        await ctx.scheduler.runAfter(0, internal.sync.sweepStaleBatch, { runId: args.runId });
        return;
      }
      // Re-read: completion stamps the activity row from the run doc, which
      // must include THIS batch's ops and removals.
      const completed = await ctx.db.get(args.runId);
      if (completed === null) {
        return;
      }
      await completeRun(ctx, completed, binding);
    } catch (error) {
      await ctx.runMutation(internal.sync.markRunFailed, {
        error: error instanceof Error ? error.message : "Sync sweep failed.",
        runId: args.runId,
      });
    }
  },
});

/**
 * Keeps the commit mirror bounded: the newest COMMIT_MIRROR_LIMIT rows per
 * binding stay; older mirrors are pruned (the foreign feed remains the
 * durable record, and the cursor still advances from it).
 */
async function pruneCommitMirror(
  ctx: MutationCtx,
  bindingId: Id<"datasetBindings">,
): Promise<void> {
  let seenMirrors = 0;
  for await (const mirror of ctx.db
    .query("commits")
    .withIndex("by_binding_seq", (q) => q.eq("bindingId", bindingId))
    .order("desc")) {
    seenMirrors += 1;
    if (seenMirrors > COMMIT_MIRROR_LIMIT) {
      // oxlint-disable-next-line no-await-in-loop -- bounded pruning deletes.
      await ctx.db.delete(mirror._id);
    }
  }
}

/**
 * Completes a run and stamps the binding: the binding's commit cursor (a
 * full run re-baselines it to the newest commit it observed; a tail run's
 * cursor is the last commit it actually applied), the activity row, the
 * mirror prune, and the chunk blobs' cleanup. A run flagged
 * `needsReconcile` (a commit op its tail couldn't apply) schedules a full
 * reconcile to repair the projection (#127 defect 6).
 */
async function completeRun(
  ctx: MutationCtx,
  run: Doc<"syncRuns">,
  binding: Doc<"datasetBindings">,
): Promise<void> {
  const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
    schemaId: binding.schemaId,
  });
  const finishedAt = Date.now(),
    finalEntryCount =
      schema !== null ? (schema.entryCount ?? 0) : Math.max(0, run.total - run.removed);
  await ctx.db.patch(binding._id, {
    lastAppliedCommitId: run.lastCommitId,
    lastAppliedCommitSeq: run.lastSeq,
    lastReconciledAt: run.mode === "reconcile" ? finishedAt : binding.lastReconciledAt,
    lastSyncedAt: finishedAt,
    syncedEntryCount: finalEntryCount,
  });
  await ctx.db.insert("datasetActivity", {
    added: run.added,
    bindingId: binding._id,
    entryCount: finalEntryCount,
    kind: run.mode === "reconcile" ? "reconcile" : "sync",
    needsReconcile: run.needsReconcile === true ? true : undefined,
    ops: run.ops.slice(0, ACTIVITY_OPS_LIMIT),
    removed: run.removed,
    schemaId: binding.schemaId,
    syncedAt: finishedAt,
    truncated: run.truncated,
    updated: run.updated,
  });
  await ctx.db.patch(run._id, {
    finishedAt,
    status: "completed",
  });

  await pruneCommitMirror(ctx, run.bindingId);

  await Promise.all(
    run.chunkStorageIds.map(async (storageId) => {
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // Best-effort cleanup.
      }
    }),
  );

  if (run.needsReconcile === true) {
    await ctx.scheduler.runAfter(0, internal.sync.reconcileOne, { source: run.source });
  }
}

export const finalizeRun = internalMutation({
  args: { claim: v.string(), runId: v.id("syncRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.status !== "applying" || run.claim !== args.claim) {
      // Lost the lease — a superseded action may not finalize.
      return;
    }
    const binding = await ctx.db.get(run.bindingId);
    if (binding === null) {
      throw new ConvexError("The binding vanished mid-sync.");
    }

    if (run.mode === "commit-tail") {
      // Tail runs carried their deletes explicitly — no sweep; complete now.
      await completeRun(ctx, run, binding);
      return;
    }
    // Full modes sweep the key map first — batched and resumable (#127
    // defect 9) — and complete from the last sweep batch.
    await ctx.db.patch(args.runId, { lastProgressAt: Date.now(), status: "sweeping" });
    await ctx.scheduler.runAfter(0, internal.sync.sweepStaleBatch, { runId: args.runId });
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
  handler: async (ctx, args) => {
    await auth(ctx);
    return ctx.db
      .query("commits")
      .withIndex("by_binding_seq", (q) => q.eq("bindingId", args.bindingId))
      .order("desc")
      .take(50);
  },
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
 * what the commit touched). Entries are fetched in batched `listEntriesForIds`
 * calls instead of one `getEntry` per mapping — the old shape was an N+1
 * over up to 2,000 component reads (#127 defect 11). Bounded — this serves
 * the demo-scale datasets.
 */
export const commitFeatureMap = query({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    const mappings = await ctx.db
      .query("bindingEntries")
      .withIndex("by_binding", (q) => q.eq("bindingId", args.bindingId))
      .take(2000);
    const entriesById = new Map<string, { data: unknown }>();
    for (let start = 0; start < mappings.length; start += COMMIT_FEATURE_ID_BATCH) {
      const ids = mappings.slice(start, start + COMMIT_FEATURE_ID_BATCH).map((m) => m.entryId);
      // oxlint-disable-next-line no-await-in-loop -- one component read per bounded id batch.
      const entries: Array<{ _id: string; data: unknown }> = await ctx.runQuery(
        components.jsonCms.lib.listEntriesForIds,
        { entryIds: ids, viewerId },
      );
      for (const entry of entries) {
        entriesById.set(entry._id, entry);
      }
    }
    return mappings.map((mapping) => {
      const entry = entriesById.get(mapping.entryId);
      const data =
        entry !== undefined && typeof entry.data === "object" && entry.data !== null
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the guards beside it enforce the object shape at runtime.
            (entry.data as Record<string, unknown>)
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
    });
  },
  returns: v.array(
    v.object({
      data: v.record(v.string(), v.any()),
      entryKey: v.string(),
      label: v.string(),
    }),
  ),
});

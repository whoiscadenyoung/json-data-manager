import { queryOptions } from "@tanstack/react-query";

import {
  clientOf,
  queryRow,
  queryRows,
  queryScalar,
  throwPostgrestError,
  type StoreOptions,
} from "./client";
import {
  chunkByJsonBytes,
  COMMIT_TAIL_PAGE,
  fetchManifestLayer,
  fetchRowsPage,
  getSource,
  type BoundSource,
  type CommitFeedEntry,
  type ProjectionRow,
} from "./sources";

/**
 * The bound-datasets store (design doc §8.1 "bindings.ts # stage 7"; issue
 * #206) — the keyed/resumable sync engine's CLIENT half over migration 0012's
 * tables + definer RPCs. The server half of every state transition lives in
 * the migration (0012_bound_datasets_stage7.sql); this module is the Convex
 * sync engine's driver legs, ported from `app/convex/sources/sync.ts`
 * (READ-ONLY parity source) with the scheduler hops replaced by awaited RPC
 * calls from the browser:
 *
 *   startRun      → rpc binding_start_run   (join-or-revive + the claim lease)
 *   collectRows   → THIS FILE: drain the registered source's pages to the
 *                   null cursor (#127 defect 1), chunk + upload them to the
 *                   sync-chunks bucket, then rpc binding_mark_collected
 *   applyChunks   → download chunk by chunk, rpc binding_apply_rows_batch /
 *                   binding_apply_commits_batch per forward-only checkpoint
 *   finalizeRun   → rpc binding_finalize_run (tail completes; full modes go
 *                   sweeping) + rpc binding_sweep_batch until a short batch
 *   completeRun   → server-side inside the RPCs (binding stamps, activity
 *                   row, mirror prune, keep-N retention)
 *   reconcileAll  → pg_cron weekly (`binding_schedule_reconciles`) inserting
 *                   run rows this module's resumeDueRun claims and drains —
 *                   the cron has no browser, so the scheduled run is a WORK
 *                   ITEM, not a server-driven loop (the §16 placement
 *                   decision recorded in the migration).
 *
 * The #127 invariants ride the run rows, so they hold across a refresh: the
 * cursor is the drained payload's LAST commit (never newestCommit), a full
 * pass reads newestCommit BEFORE the rows, one claim holder applies per run,
 * checkpoints move only forward (server-side), and a run whose collect keeps
 * dying is failed by the attempt budget instead of revived forever. A failed
 * driver deletes its uploaded chunks best-effort (the blob-cleanup rule) —
 * a driver that dies MID-run leaves the run resumable instead (the next
 * client claims it; chunk paths ride the run row).
 *
 * NOTE: narrow local interfaces typed from the migration's DDL/RPC shapes,
 * not the generated `database.types.ts` (see `./client`).
 */

// ---------------------------------------------------------------------------
// Wire shapes (migration 0012 tables + RPC returns)
// ---------------------------------------------------------------------------

/** The dataset_bindings row (camelCase aliases over the DDL columns). */
export interface BindingRow {
  id: string;
  source: string;
  datasetId: string;
  schemaMapping: unknown;
  lastAppliedCommitId: string | null;
  lastAppliedCommitSeq: number | null;
  lastSyncedAt: string | null;
  lastReconciledAt: string | null;
  keepVersions: number | null;
  pinnedRefs: string[];
  sourceUpdatedAt: string | null;
  syncedEntryCount: number | null;
  remoteRevision: number | null;
  remoteSchemaVersion: string | null;
  createdAt: string;
}

/** The sync_runs row, as the engine's progress reads use it. */
export interface SyncRunRow {
  id: string;
  bindingId: string;
  mode: "commit-tail" | "reconcile" | "sync";
  status: "collecting" | "applying" | "sweeping" | "completed" | "failed";
  total: number;
  added: number;
  updated: number;
  removed: number;
  applied: number;
  chunkIndex: number;
  rowOffset: number;
  chunkPaths: string[];
  claim: string | null;
  needsReconcile: boolean | null;
  lastCommitId: string | null;
  lastSeq: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastProgressAt: string;
}

/** The dataset_activity row — the History feed's per-sync summary. */
export interface ActivityRow {
  id: string;
  bindingId: string;
  kind: "sync" | "reconcile" | null;
  added: number;
  updated: number;
  removed: number;
  entryCount: number;
  /** The capped activity ops ({label, op, detail?}), shapeless past that. */
  ops: Array<{ detail?: string; label: string; op: "add" | "remove" | "update" }>;
  needsReconcile: boolean | null;
  syncedAt: string;
  truncated: boolean | null;
}

/** The commit_mirror row — the History rail's applied-commit record. */
export interface CommitMirrorRow {
  id: string;
  bindingId: string;
  foreignCommitId: string;
  seq: number;
  message: string;
  /** The feed's ops verbatim ({entryKey, op, fields, geometryChanged}). */
  ops: unknown;
  at: string;
  appliedAt: string;
}

/** One active run with its binding — the due-runs / progress projection. */
export interface ActiveRunRow {
  id: string;
  mode: SyncRunRow["mode"];
  status: SyncRunRow["status"];
  total: number;
  applied: number;
  added: number;
  updated: number;
  removed: number;
  startedAt: string;
  lastProgressAt: string;
  binding: { datasetId: string; source: string } | null;
}

const BINDING_SELECT =
  "id,source,datasetId:dataset_id,schemaMapping:schema_mapping,lastAppliedCommitId:last_applied_commit_id," +
  "lastAppliedCommitSeq:last_applied_commit_seq,lastSyncedAt:last_synced_at,lastReconciledAt:last_reconciled_at," +
  "keepVersions:keep_versions,pinnedRefs:pinned_refs,sourceUpdatedAt:source_updated_at," +
  "syncedEntryCount:synced_entry_count,remoteRevision:remote_revision,remoteSchemaVersion:remote_schema_version,createdAt:created_at";

const RUN_SELECT =
  "id,bindingId:binding_id,mode,status,total,added,updated,removed,applied,chunkIndex:chunk_index," +
  "rowOffset:row_offset,chunkPaths:chunk_paths,claim,needsReconcile:needs_reconcile," +
  "lastCommitId:last_commit_id,lastSeq:last_seq,error,startedAt:started_at,finishedAt:finished_at," +
  "lastProgressAt:last_progress_at";

const ACTIVITY_SELECT =
  "id,bindingId:binding_id,kind,added,updated,removed,entryCount:entry_count,ops," +
  "needsReconcile:needs_reconcile,syncedAt:synced_at,truncated";

const COMMIT_SELECT =
  "id,bindingId:binding_id,foreignCommitId:foreign_commit_id,seq,message,ops,at,appliedAt:applied_at";

// ---------------------------------------------------------------------------
// Engine constants (sync.ts parity; the server halves are the migration's
// binding_*() functions — keep the pairs in lockstep)
// ---------------------------------------------------------------------------

/** Rows per applying batch (sync.ts's APPLY_BATCH_ROWS). */
const APPLY_BATCH_ROWS = 100;
/** Commits per tail batch (sync.ts's APPLY_BATCH_COMMITS). */
const APPLY_BATCH_COMMITS = 25;
/** The sweep's batch size — the loop's stop signal (binding_sweep_batch_size). */
const SWEEP_BATCH = 100;
/** The History feed's cap (dataset_activity's per-sync rows, sync.ts cap parity). */
export const HISTORY_LIMIT = 200;
/** The History rail's commit cap (sync.ts listCommits take(50)). */
export const COMMITS_LIMIT = 50;

// ---------------------------------------------------------------------------
// Reads (TanStack Query `queryOptions` per function, design §8.1)
// ---------------------------------------------------------------------------

/** The binding row for one dataset (one per dataset — the DDL's unique constraint), or null when the dataset is not bound. */
export function bindingForDatasetQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "forDataset", args],
    queryFn: async (): Promise<BindingRow | null> =>
      await queryRow<BindingRow>(
        clientOf(options)
          .from("dataset_bindings")
          .select(BINDING_SELECT)
          .eq("dataset_id", args.datasetId)
          .limit(1),
      ),
  });
}

/** The binding row for one source key, or null when the source is not bound. */
export function bindingForSourceQueryOptions(args: { source: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "forSource", args],
    queryFn: async (): Promise<BindingRow | null> =>
      await queryRow<BindingRow>(
        clientOf(options)
          .from("dataset_bindings")
          .select(BINDING_SELECT)
          .eq("source", args.source)
          .limit(1),
      ),
  });
}

/** The latest run of one binding, newest first — the sync card's progress row. */
export function latestRunQueryOptions(args: { bindingId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "latestRun", args],
    queryFn: async (): Promise<SyncRunRow | null> =>
      await queryRow<SyncRunRow>(
        clientOf(options)
          .from("sync_runs")
          .select(RUN_SELECT)
          .eq("binding_id", args.bindingId)
          .order("started_at", { ascending: false })
          .limit(1),
      ),
  });
}

/**
 * Every active run (collecting/applying/sweeping) with its binding — the
 * dashboard-level view of runs the weekly cron scheduled but no client has
 * claimed yet (the pg_cron work items; resumeDueRun drains one).
 */
export function dueRunsQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "dueRuns"],
    queryFn: async (): Promise<ActiveRunRow[]> =>
      await queryRows<ActiveRunRow>(
        clientOf(options)
          .from("sync_runs")
          .select(
            "id,mode,status,total,applied,added,updated,removed,startedAt:started_at," +
              "lastProgressAt:last_progress_at,binding:dataset_bindings(datasetId:dataset_id,source)",
          )
          .in("status", ["collecting", "applying", "sweeping"])
          .order("started_at", { ascending: false }),
      ),
  });
}

/** The History feed for one binding — per-sync summaries, newest first (capped; `truncated` flags a capped ops array). */
export function historyQueryOptions(args: { bindingId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "history", args],
    queryFn: async (): Promise<ActivityRow[]> =>
      await queryRows<ActivityRow>(
        clientOf(options)
          .from("dataset_activity")
          .select(ACTIVITY_SELECT)
          .eq("binding_id", args.bindingId)
          .order("synced_at", { ascending: false })
          .limit(HISTORY_LIMIT),
      ),
  });
}

/** The applied-commit mirror for one binding, newest first — the History rail's data. */
export function commitsQueryOptions(args: { bindingId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "commits", args],
    queryFn: async (): Promise<CommitMirrorRow[]> =>
      await queryRows<CommitMirrorRow>(
        clientOf(options)
          .from("commit_mirror")
          .select(COMMIT_SELECT)
          .eq("binding_id", args.bindingId)
          .order("seq", { ascending: false })
          .limit(COMMITS_LIMIT),
      ),
  });
}

/** The remote_sources check row for one source (the manifest registry), or null when never checked. */
export interface RemoteSourceRow {
  source: string;
  checkedAt: string | null;
  error: string | null;
  /** The last successful manifest read: {title, schemaVersion, revision, geometryType, schema, description?, featureCount?}. */
  layer: unknown;
  recordUrlTemplate: string | null;
}

export function remoteSourceQueryOptions(args: { source: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:bindings", "remoteSource", args],
    queryFn: async (): Promise<RemoteSourceRow | null> =>
      await queryRow<RemoteSourceRow>(
        clientOf(options)
          .from("remote_sources")
          .select("source,checkedAt:checked_at,error,layer,recordUrlTemplate:record_url_template")
          .eq("source", args.source)
          .limit(1),
      ),
  });
}

/**
 * The projection's key → feature map for one binding (sync.ts's
 * commitFeatureMap parity): a commit's ops name entries by foreign key; this
 * resolves each key to its current data so the client can draw what the
 * commit touched (the design's "current position" rule). Bounded at the
 * Convex read's own 2000-mapping cap — this serves demo-scale datasets.
 */
export function featuresForBindingQueryOptions(
  args: { bindingId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:bindings", "features", args],
    queryFn: async (): Promise<Array<{ data: Record<string, unknown>; entryKey: string }>> =>
      await queryRows<{ data: Record<string, unknown>; entryKey: string }>(
        clientOf(options)
          .from("binding_entries")
          .select("entryKey:entry_key,data:entries(data)")
          .eq("binding_id", args.bindingId)
          .limit(2000),
      ),
  });
}

// ---------------------------------------------------------------------------
// Staleness (the dashboard card + dataset page badges; the Convex
// sync-staleness.ts split, PG-flavored: timestamps are ISO strings)
// ---------------------------------------------------------------------------

/** True when the (client-read) source changed after the last completed sync. */
export function isSyncStale(
  binding: Pick<BindingRow, "lastSyncedAt" | "sourceUpdatedAt">,
): boolean {
  if (binding.sourceUpdatedAt === null || binding.lastSyncedAt === null) {
    return false;
  }
  return Date.parse(binding.sourceUpdatedAt) > Date.parse(binding.lastSyncedAt);
}

/** True when a checked remote manifest's revision moved past the binding's synced revision. */
export function isRemoteStale(
  binding: Pick<BindingRow, "remoteRevision">,
  latestRevision: number | undefined,
): boolean {
  if (latestRevision === undefined || binding.remoteRevision === null) {
    return false;
  }
  return latestRevision > binding.remoteRevision;
}

// ---------------------------------------------------------------------------
// The engine driver
// ---------------------------------------------------------------------------

/** One drained collect leg's payload (sync.ts's CollectedPayload). */
interface CollectedPayload {
  chunkPaths: string[];
  cursorCommitId?: string;
  cursorSeq?: number;
  /** Remote sources: the FIRST rows page's layer revision (what completion stamps). */
  remoteRevision?: number;
  total: number;
}

/** The storage path of one chunk blob — the first segment keys the bucket policies to the owning dataset (migration 0012). */
function chunkPathOf(datasetId: string, runId: string, index: number): string {
  return `${datasetId}/sync-runs/${runId}/${index}.json`;
}

async function readBindingBySource(
  client: ReturnType<typeof clientOf>,
  source: string,
): Promise<BindingRow | null> {
  return await queryRow<BindingRow>(
    client.from("dataset_bindings").select(BINDING_SELECT).eq("source", source).limit(1),
  );
}

async function readRunRow(client: ReturnType<typeof clientOf>, runId: string): Promise<SyncRunRow> {
  const run = await queryRow<SyncRunRow>(
    client.from("sync_runs").select(RUN_SELECT).eq("id", runId).limit(1),
  );
  if (run === null) {
    throw new Error(`Sync run ${runId} vanished mid-flight.`);
  }
  return run;
}

/** Executes a void RPC — PostgREST answers 204; only the error matters. */
async function execRpc(
  client: ReturnType<typeof clientOf>,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.rpc(name, args);
  if (error !== null) {
    throwPostgrestError(error);
  }
}

/** Best-effort chunk cleanup (the blob-cleanup rule): a failed driver never leaves its uploads reachable only from a dead run. */
async function cleanupChunks(
  client: ReturnType<typeof clientOf>,
  chunkPaths: string[],
): Promise<void> {
  if (chunkPaths.length === 0) {
    return;
  }
  try {
    await client.storage.from("sync-chunks").remove(chunkPaths);
  } catch {
    // Best-effort — an orphaned chunk object is recorded as a residual in
    // the migration header; it never blocks the next run.
  }
}

/** Uploads one chunk's rows to the sync-chunks bucket and records its path. */
async function storeChunk(
  client: ReturnType<typeof clientOf>,
  datasetId: string,
  runId: string,
  chunkPaths: string[],
  index: number,
  chunk: unknown,
): Promise<void> {
  const path = chunkPathOf(datasetId, runId, index),
    body = new Blob([JSON.stringify(chunk)], { type: "application/json" }),
    { error } = await client.storage.from("sync-chunks").upload(path, body);
  if (error !== null) {
    throw new Error(`Chunk upload failed: ${error.message}`);
  }
  chunkPaths.push(path);
}

/** One state page from whichever transport the source carries (the collect loop's single await point). */
async function readSourcePage(
  source: BoundSource,
  cursor: string | null,
): Promise<{ cursor: string | null; revision?: number; rows: ProjectionRow[] }> {
  if (source.transport === "http") {
    return await fetchRowsPage(source, cursor);
  }
  return await source.listRows(cursor);
}

/**
 * The collect leg for a client-read source (sync.ts's collectCommitTail +
 * collectFullState). The tail drains the feed page by page since the
 * binding's cursor and ends on the payload's LAST commit (never
 * newestCommit — the old stamping skipped past commits the capped read never
 * carried, #127 defect 2/5). A full pass reads newestCommit BEFORE the rows —
 * a commit landing between the reads is re-applied idempotently by the tail
 * instead of being stamped as applied while missing (#127 defect 5) — and
 * drains the state until the null cursor (#127 defect 1).
 */
// oxlint-disable-next-line eslint/complexity -- a faithful port of sync.ts's collect legs; ad hoc splitting risks the drain contract (page → chunks → cursor), the same note the sync card's Convex counterpart carries.
async function collectForRun(
  client: ReturnType<typeof clientOf>,
  source: BoundSource,
  binding: BindingRow,
  runId: string,
  mode: "commit-tail" | "reconcile" | "sync",
  payload: CollectedPayload,
): Promise<void> {
  if (mode === "commit-tail") {
    if (source.transport !== "client" || source.commitsSince === undefined) {
      throw new Error(`Source ${source.key} lost its commit feed mid-run.`);
    }
    const feed = source.commitsSince;
    let sinceSeq = binding.lastAppliedCommitSeq ?? 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- paging the tail; a short page ends the drain.
      const page: CommitFeedEntry[] = await feed(sinceSeq);
      let chunkIndex = 0;
      for (const chunk of chunkByJsonBytes<CommitFeedEntry>(page)) {
        // oxlint-disable-next-line no-await-in-loop -- sequential uploads keep driver memory bounded, mirroring the importer.
        await storeChunk(client, binding.datasetId, runId, payload.chunkPaths, chunkIndex, chunk);
        chunkIndex += 1;
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
    return;
  }

  const newest =
    source.transport === "client" && source.newestCommit !== undefined
      ? await source.newestCommit()
      : null;
  let rowsCursor: string | null = null;
  let chunkIndex = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- paging across requests; the null cursor ends the drain.
    const page = await readSourcePage(source, rowsCursor);
    if (payload.remoteRevision === undefined) {
      payload.remoteRevision = page.revision;
    }
    for (const chunk of chunkByJsonBytes<ProjectionRow>(page.rows)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential uploads keep driver memory bounded, mirroring the importer.
      await storeChunk(client, binding.datasetId, runId, payload.chunkPaths, chunkIndex, chunk);
      chunkIndex += 1;
    }
    payload.total += page.rows.length;
    if (page.cursor === null) {
      break;
    }
    rowsCursor = page.cursor;
  }
  if (newest !== null) {
    payload.cursorCommitId = newest.foreignCommitId;
    payload.cursorSeq = newest.seq;
  }
}

/**
 * The apply + finalize legs (sync.ts's applyChunks → finalizeRun →
 * sweepStaleBatch), driven from the run row's own checkpoints — the same
 * path a fresh run takes and a resumed run takes (a refresh mid-run leaves
 * the run resumable: claim it, then re-enter here).
 */
// oxlint-disable-next-line eslint/complexity -- a faithful port of sync.ts's applyChunks; ad hoc splitting risks the ordered chunk → batch → checkpoint chain.
async function applyFromRun(
  client: ReturnType<typeof clientOf>,
  runId: string,
  claim: string,
): Promise<void> {
  let run = await readRunRow(client, runId);
  const batchSize = run.mode === "commit-tail" ? APPLY_BATCH_COMMITS : APPLY_BATCH_ROWS;
  for (let chunkIndex = run.chunkIndex; chunkIndex < run.chunkPaths.length; chunkIndex += 1) {
    const path = run.chunkPaths[chunkIndex];
    // oxlint-disable-next-line no-await-in-loop -- chunks apply in order; the checkpoint depends on it.
    const blob = await client.storage.from("sync-chunks").download(path);
    if (blob.error !== null || blob.data === null) {
      throw new Error(`Sync chunk ${chunkIndex} is missing from storage.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- ordered chunks; the text feeds the batch loop below.
    const text = await blob.data.text();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON was written by the collect leg from the source's own typed rows.
    const items = JSON.parse(text) as Array<Record<string, unknown>>;
    const startOffset = chunkIndex === run.chunkIndex ? run.rowOffset : 0;
    for (let offset = startOffset; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize),
        rowOffset = offset + batch.length;
      if (run.mode === "commit-tail") {
        // oxlint-disable-next-line no-await-in-loop -- each batch's checkpoint depends on the previous one committing.
        await execRpc(client, "binding_apply_commits_batch", {
          p_chunk_index: chunkIndex,
          p_claim: claim,
          p_commits: batch,
          p_row_offset: rowOffset,
          p_run_id: runId,
        });
      } else {
        // oxlint-disable-next-line no-await-in-loop -- each batch's checkpoint depends on the previous one committing.
        await execRpc(client, "binding_apply_rows_batch", {
          p_chunk_index: chunkIndex,
          p_claim: claim,
          p_rows: batch,
          p_row_offset: rowOffset,
          p_run_id: runId,
        });
      }
    }
    // Re-read so the next chunk's resume point is the server's (forward-only
    // checkpoints — a superseded driver cannot drag it back, and this driver
    // follows rather than assumes).
    // oxlint-disable-next-line no-await-in-loop -- same chain; the next chunk's offset reads this checkpoint.
    run = await readRunRow(client, runId);
  }

  await execRpc(client, "binding_finalize_run", { p_claim: claim, p_run_id: runId });
  if (run.mode !== "commit-tail") {
    // Full modes sweep the key map first — batched and resumable (#127
    // defect 9) — and the short batch's call completes the run.
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the sweep resumes batch by batch; a short batch ends it.
      const removed = await queryScalar<number>(
        client.rpc("binding_sweep_batch", { p_claim: claim, p_run_id: runId }),
      );
      if (removed < SWEEP_BATCH) {
        break;
      }
    }
  }
}

/** The driver's result: what happened, for the sync card's toast. */
export interface SyncOutcome {
  alreadyRunning: boolean;
  needsReconcile: boolean;
  runId: string | null;
}

/**
 * The drivers' shared body: start (or join), collect, mark, apply, finalize,
 * sweep, complete — with the failure path failing the run cleanly and
 * cleaning up this driver's uploads (sync.ts's try/catch shape).
 */
// oxlint-disable-next-line eslint/complexity -- the start-or-join + mode-decision + failure-path shape IS the engine's contract (sync.ts's startRunInternal); splitting it would scatter the lease handling.
async function driveSync(
  options: StoreOptions | undefined,
  sourceKey: string,
  requestedMode: "reconcile" | "sync",
): Promise<SyncOutcome> {
  const client = clientOf(options),
    source = getSource(sourceKey);

  // Find-or-create the binding (sync.ts's ensureBoundDataset): the dataset
  // descriptor comes from the source itself.
  let binding = await readBindingBySource(client, sourceKey);
  if (binding === null) {
    const schema = source.dataset.schema,
      properties =
        schema.properties === undefined || schema.properties === null
          ? []
          : Object.keys(schema.properties);
    await execRpc(client, "binding_ensure", {
      p_dataset: {
        description: source.dataset.description,
        geometryType: source.dataset.geometryType ?? null,
        isGeospatial: source.dataset.kind === "geospatial",
        jsonSchema: schema,
        properties,
        title: source.dataset.title,
      },
      p_schema_mapping: source.mapping,
      p_source: sourceKey,
    });
    binding = await readBindingBySource(client, sourceKey);
    if (binding === null) {
      throw new Error(`binding_ensure did not leave a binding row for ${sourceKey}.`);
    }
  }

  // Mode decision (sync.ts's startRunInternal): "sync" prefers the design's
  // primary path — the commit tail since the binding's cursor — whenever the
  // source has a feed and the binding has a baseline. Full passes
  // re-baseline the cursor; "reconcile" always diffs full state.
  const tailEligible =
      requestedMode === "sync" &&
      source.transport === "client" &&
      source.commitsSince !== undefined &&
      binding.lastAppliedCommitSeq !== null,
    runMode: "commit-tail" | "reconcile" | "sync" = tailEligible ? "commit-tail" : requestedMode;

  const started = await queryRows<{ already_running: boolean; claim: string; run_id: string }>(
    client.rpc("binding_start_run", { p_mode: runMode, p_source: sourceKey }),
  );
  const start = started[0];
  if (start === undefined) {
    throw new Error("binding_start_run returned no run.");
  }
  if (start.already_running) {
    return { alreadyRunning: true, needsReconcile: false, runId: start.run_id };
  }

  const payload: CollectedPayload = { chunkPaths: [], total: 0 };
  try {
    await collectForRun(client, source, binding, start.run_id, runMode, payload);
    const won = await queryScalar<boolean>(
      client.rpc("binding_mark_collected", {
        p_claim: start.claim,
        p_chunk_paths: payload.chunkPaths,
        p_last_commit_id: payload.cursorCommitId ?? null,
        p_last_seq: payload.cursorSeq ?? null,
        p_remote_revision: payload.remoteRevision ?? null,
        p_run_id: start.run_id,
        p_total: payload.total,
      }),
    );
    if (!won) {
      // The lease was rotated while this collect ran (a revive won) —
      // schedule nothing, and don't touch the winner's blobs.
      return { alreadyRunning: true, needsReconcile: false, runId: start.run_id };
    }
    await applyFromRun(client, start.run_id, start.claim);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    try {
      await cleanupChunks(client, payload.chunkPaths);
    } finally {
      await execRpc(client, "binding_fail_run", {
        p_claim: start.claim,
        p_error: message,
        p_run_id: start.run_id,
      });
    }
    throw error;
  }

  const finalRun = await readRunRow(client, start.run_id);
  return {
    alreadyRunning: false,
    needsReconcile: finalRun.needsReconcile === true,
    runId: start.run_id,
  };
}

// One driver per source at a time (a double-click "Sync now" must not fork
// two browser loops; the run rows already join server-side).
const inFlightSources = new Set<string>();

/**
 * Runs one sync of a bound source — the dashboard's "Sync now". Joins a live
 * run instead of forking (`alreadyRunning`); completes with a repair pass
 * scheduled when a commit op could not be applied from the tail alone
 * (#127 defect 6 — the auto-reconcile).
 */
export async function runSync(
  args: { mode?: "reconcile" | "sync"; source: string },
  options?: StoreOptions,
): Promise<SyncOutcome> {
  if (inFlightSources.has(args.source)) {
    return { alreadyRunning: true, needsReconcile: false, runId: null };
  }
  inFlightSources.add(args.source);
  try {
    const outcome = await driveSync(options, args.source, args.mode ?? "sync");
    if (outcome.needsReconcile) {
      // The tail hit an op it could not apply — the full pass rebuilds the
      // key from source state. Fire-and-forget (this driver still holds the
      // source's in-flight slot, so a double-kick cannot loop); a failed
      // repair pass surfaces through the run rows' error, not by rejecting
      // the already-reported sync.
      void driveSync(options, args.source, "reconcile").catch(() => {});
    }
    return outcome;
  } finally {
    inFlightSources.delete(args.source);
  }
}

/**
 * Claims and drains one scheduled/abandoned run — the pg_cron work items'
 * consumer (binding_claim_run rotates the lease; a null answer means nothing
 * to claim). This is what makes the weekly reconcile land: the cron inserts
 * the run row, the next client to see it finishes it.
 */
// oxlint-disable-next-line eslint/complexity -- the collect-revive vs apply-resume split is the claim contract's shape (sync.ts's reviveCollectingRun/reviveApplyingRun); splitting it would duplicate the failure path.
export async function resumeDueRun(
  args: { runId: string },
  options?: StoreOptions,
): Promise<boolean> {
  const client = clientOf(options);
  const claim = await queryScalar<string | null>(
    client.rpc("binding_claim_run", { p_run_id: args.runId }),
  );
  if (claim === null || claim === "") {
    return false;
  }
  const run = await readRunRow(client, args.runId);
  if (run.status === "collecting") {
    // Revived collect: the source state is re-read from scratch (the collect
    // leg was never checkpointed mid-drain — mark_collected replaces the
    // chunk set), then the usual apply.
    const binding = await readBindingBySource(client, await sourceOfRun(client, args.runId));
    if (binding === null) {
      return false;
    }
    const source = getSource(binding.source);
    const payload: CollectedPayload = { chunkPaths: [], total: 0 };
    try {
      await collectForRun(client, source, binding, args.runId, run.mode, payload);
      const won = await queryScalar<boolean>(
        client.rpc("binding_mark_collected", {
          p_claim: claim,
          p_chunk_paths: payload.chunkPaths,
          p_last_commit_id: payload.cursorCommitId ?? null,
          p_last_seq: payload.cursorSeq ?? null,
          p_remote_revision: payload.remoteRevision ?? null,
          p_run_id: args.runId,
          p_total: payload.total,
        }),
      );
      if (!won) {
        return false;
      }
      await applyFromRun(client, args.runId, claim);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed.";
      try {
        await cleanupChunks(client, payload.chunkPaths);
      } finally {
        await execRpc(client, "binding_fail_run", {
          p_claim: claim,
          p_error: message,
          p_run_id: args.runId,
        });
      }
      throw error;
    }
    return true;
  }
  await applyFromRun(client, args.runId, claim);
  return true;
}

/** The binding a run belongs to (the resume path's source lookup). */
async function sourceOfRun(client: ReturnType<typeof clientOf>, runId: string): Promise<string> {
  const run = await queryRow<{ bindingId: string }>(
    client.from("sync_runs").select("bindingId:binding_id").eq("id", runId).limit(1),
  );
  if (run === null) {
    throw new Error(`Sync run ${runId} vanished mid-flight.`);
  }
  const binding = await queryRow<{ source: string }>(
    client.from("dataset_bindings").select("source").eq("id", run.bindingId).limit(1),
  );
  if (binding === null) {
    throw new Error(`Sync run ${runId} has no binding.`);
  }
  return binding.source;
}

// ---------------------------------------------------------------------------
// Writes (plain functions; features wrap them in useMutation + invalidation)
// ---------------------------------------------------------------------------

/** Unbinds one binding — deletes the projection (dataset) + every sync-state row; the source is untouched (the creator-only exit path). */
export async function unbind(args: { bindingId: string }, options?: StoreOptions): Promise<void> {
  await execRpc(clientOf(options), "binding_unbind", { p_binding_id: args.bindingId });
}

/**
 * Sets the binding's keep-N/pin retention (the §7 knobs; completion mirrors
 * them into the chain's version policy and runs the stage-4 enforcement).
 * Returns the affected row count: 0 = denied (not an editor of the bound
 * dataset — the RLS update policy) or already gone.
 */
export async function setRetention(
  args: { bindingId: string; keepVersions?: number | null; pinnedRefs?: string[] },
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.keepVersions !== undefined) {
    patch.keep_versions = args.keepVersions;
  }
  if (args.pinnedRefs !== undefined) {
    patch.pinned_refs = args.pinnedRefs;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Retention update needs a field to set.");
  }
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("dataset_bindings").update(patch).eq("id", args.bindingId).select("id"),
  );
  return rows.length;
}

/**
 * Checks one remote source now (remoteSources.check parity): fetches the
 * manifest through the validated HTTP client and records the result — a
 * failed check records its error and KEEPS the last successful layer.
 */
export async function checkRemoteSource(
  args: { source: string },
  options?: StoreOptions,
): Promise<void> {
  const client = clientOf(options),
    source = getSource(args.source);
  if (source.transport !== "http") {
    throw new Error(`Source ${args.source} is not a remote source.`);
  }
  try {
    const manifest = await fetchManifestLayer(source);
    await execRpc(client, "remote_source_check", {
      p_layer: {
        description: manifest.layer.description ?? null,
        featureCount: manifest.layer.featureCount ?? null,
        geometryType: manifest.layer.geometryType,
        revision: manifest.layer.revision,
        schema: manifest.layer.schema,
        schemaVersion: manifest.layer.schemaVersion,
        title: manifest.layer.title,
      },
      p_ok: true,
      p_record_url_template: manifest.recordUrlTemplate ?? null,
      p_source: args.source,
    });
  } catch (error) {
    await execRpc(client, "remote_source_check", {
      p_error: error instanceof Error ? error.message : "The check failed.",
      p_ok: false,
      p_source: args.source,
    });
  }
}

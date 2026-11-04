/**
 * Tile-archive rebuild manager (issue #58 part 3) — decides WHEN a dataset's
 * tile archive gets rebuilt and runs exactly one build at a time per dataset.
 * The build itself runs in {@link ./tile-archive.worker.ts} (a web worker that
 * owns a standalone ConvexClient): one build = one message round trip.
 *
 * Correctness does NOT live here. A rebuild races edits by design; part 2's
 * `setMapTileArchive` `expectedVersion` guard makes a build that started
 * against stale data self-discarding, so this module only needs to keep
 * *scheduling* until the schema's `mapTileCacheVersion` has a matching,
 * current-format archive installed. Single-flight + a trailing debounce
 * keep bursts (an N-chunk import bumps the version N times) to one build.
 */
import {
  rememberBelowThresholdSkip,
  TileArchiveScheduler,
  type TileArchiveBackoff,
  type TileArchiveBuildOutcome,
  type TileArchiveBuildPhase,
  type TileArchiveBuildState,
} from "@caden/maps/build-scheduler";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { getContext } from "#/integrations/tanstack-query/root-provider";
import { fetchConvexToken } from "#/lib/convex-auth-token";
import { isPostgresDatasetId } from "#/lib/dataset-source";
import { sharedClient } from "#/lib/store/client";

import { isPgTileArchiveStale } from "./pg-tile-archives";
import { usePgDatasetSummaries } from "./pg-tile-archives-react";

/**
 * Which auth surface a worker token request is for: the Convex JWT the
 * standalone ConvexClient `setAuth`s with, or the Supabase access token the
 * worker's own `createClient` rides (RLS applies to every PG read/write the
 * PG build path makes). Omitted = "convex" (the only kind before stage 2).
 */
export type TileTokenSource = "convex" | "supabase";

/** Main thread → worker: one build per message, plus token-fetch replies. */
export type TileArchiveWorkerInbound =
  | { schemaId: string; type: "build" }
  | { requestId: number; token: string | null; type: "token" };

/** Worker → main thread: token requests, transient `phase` messages, then one terminal message. */
export type TileArchiveWorkerOutbound =
  | { requestId: number; source?: TileTokenSource; type: "token-request" }
  | { schemaId: string; type: "phase"; phase: TileArchiveBuildPhase }
  | { done: number; schemaId: string; total: number; type: "progress" }
  | {
      builtVersion: number;
      bytes: number;
      maxZoom: number;
      schemaId: string;
      type: "done";
    }
  | { schemaId: string; type: "stale-discarded" }
  | {
      reason: "not-geospatial" | "below-threshold";
      schemaId: string;
      type: "skipped";
      /** The schema version the worker read (0 for not-geospatial, where the
       * schema was never readable). Lets the manager memoize a below-threshold
       * skip against the exact version it applies to. */
      version: number;
    }
  | { message: string; schemaId: string; type: "error" };

// --- Build-state store (module-level; survives route unmounts) ---

const buildStates = new Map<string, TileArchiveBuildState>();
const buildListeners = new Set<() => void>();

/** Row-fetch progress of a running build (the long phase of a large dataset). */
export interface TileArchiveBuildProgress {
  done: number;
  total: number;
}

const buildProgress = new Map<string, TileArchiveBuildProgress>();

/**
 * A dataset's last failed build (issue #184). Unlike the `"error"` build
 * state, which flashes and reverts, this persists until a build succeeds so
 * the map can keep saying "tiles failed to build" across retries.
 */
export interface TileArchiveBuildFailure {
  message: string;
  /** Consecutive failures at the current version (0 until the scheduler reports). */
  failures: number;
  /** When the scheduler's automatic retry fires; undefined when none is pending. */
  retryAt: number | undefined;
}

const buildFailures = new Map<string, TileArchiveBuildFailure>();

function notifyBuildListeners(): void {
  for (const listener of buildListeners) listener();
}

/** Records a failed build; toasts only the first failure of a streak. */
function recordBuildFailure(schemaId: string, message: string): void {
  const previous = buildFailures.get(schemaId);
  if (previous === undefined) {
    toast.error(`Tile rebuild failed (${schemaId.slice(-6)}): ${message}`);
  }
  buildFailures.set(schemaId, {
    failures: previous === undefined ? 0 : previous.failures,
    message,
    retryAt: undefined,
  });
  notifyBuildListeners();
}

function clearBuildFailure(schemaId: string): void {
  if (buildFailures.delete(schemaId)) notifyBuildListeners();
}

const DEFAULT_FAILURE_MESSAGE = "Tile-archive build failed.";

/**
 * Scheduler callback: attaches the backoff window to the failure record and
 * persists it, so a reload neither forgets the failure nor retries early.
 */
function applyBackoff(schemaId: string, backoff: TileArchiveBackoff | undefined): void {
  const failure = buildFailures.get(schemaId);
  writeStoredBackoff(
    schemaId,
    backoff === undefined
      ? undefined
      : { ...backoff, message: failure === undefined ? DEFAULT_FAILURE_MESSAGE : failure.message },
  );
  if (failure === undefined) return;
  buildFailures.set(
    schemaId,
    backoff === undefined
      ? { ...failure, retryAt: undefined }
      : { ...failure, failures: backoff.failures, retryAt: backoff.retryAt },
  );
  notifyBuildListeners();
}

// --- Backoff persistence (issue #184): the scheduler is in-memory, so
// without this every page reload bought a failing dataset a fresh attempt ---

const BACKOFF_STORAGE_KEY = "tile-archive-backoff";

/** Per dataset: the scheduler's backoff window plus the error the alert shows. */
interface StoredBackoff extends TileArchiveBackoff {
  message: string;
}

function isStoredBackoff(value: unknown): value is StoredBackoff {
  return (
    isRecord(value) &&
    typeof value.failures === "number" &&
    typeof value.message === "string" &&
    typeof value.retryAt === "number" &&
    typeof value.version === "number"
  );
}

function readStoredBackoffs(): Map<string, StoredBackoff> {
  const stored = new Map<string, StoredBackoff>();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BACKOFF_STORAGE_KEY) ?? "{}");
    if (!isRecord(parsed)) return stored;
    for (const [schemaId, value] of Object.entries(parsed)) {
      if (isStoredBackoff(value)) stored.set(schemaId, value);
    }
  } catch {
    // Storage unavailable or corrupt: start without persisted backoffs.
  }
  return stored;
}

function writeStoredBackoff(schemaId: string, backoff: StoredBackoff | undefined): void {
  const stored = readStoredBackoffs();
  if (backoff === undefined) {
    if (!stored.delete(schemaId)) return;
  } else {
    stored.set(schemaId, backoff);
  }
  try {
    if (stored.size === 0) {
      localStorage.removeItem(BACKOFF_STORAGE_KEY);
    } else {
      localStorage.setItem(BACKOFF_STORAGE_KEY, JSON.stringify(Object.fromEntries(stored)));
    }
  } catch {
    // Best effort: without storage the backoff still holds for this page.
  }
}

/** Re-arms persisted backoffs in a new scheduler and restores their alerts. */
function restoreStoredBackoffs(scheduler: TileArchiveScheduler): void {
  const stored = readStoredBackoffs();
  for (const [schemaId, backoff] of stored) {
    buildFailures.set(schemaId, {
      failures: backoff.failures,
      message: backoff.message,
      retryAt: backoff.retryAt,
    });
    scheduler.restoreBackoff(schemaId, backoff);
  }
  if (stored.size > 0) notifyBuildListeners();
}

const buildRevertTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Terminal states flash briefly, then the indicator returns to idle. */
const BUILD_STATE_REVERT_MS = 4_000;

function setBuildState(schemaId: string, state: TileArchiveBuildState): void {
  // Progress belongs to the fetch phase only; any other state retires it.
  if (state !== "fetching" && buildProgress.delete(schemaId)) notifyBuildListeners();
  const revertTimer = buildRevertTimers.get(schemaId);
  if (revertTimer !== undefined) {
    clearTimeout(revertTimer);
    buildRevertTimers.delete(schemaId);
  }
  if (state === "done" || state === "stale-discarded" || state === "error") {
    buildRevertTimers.set(
      schemaId,
      setTimeout(() => {
        buildRevertTimers.delete(schemaId);
        setBuildState(schemaId, "idle");
      }, BUILD_STATE_REVERT_MS),
    );
  }
  if (buildStates.get(schemaId) === state) return;
  buildStates.set(schemaId, state);
  if (import.meta.env.DEV) {
    console.debug(`[tile-archive] ${schemaId.slice(-6)} → ${state}`);
  }
  notifyBuildListeners();
}

/** Subscribes to per-dataset build-state changes (for `useSyncExternalStore`). */
export function subscribeTileArchiveBuildState(listener: () => void): () => void {
  buildListeners.add(listener);
  return () => {
    buildListeners.delete(listener);
  };
}

export function getTileArchiveBuildState(schemaId: string): TileArchiveBuildState {
  return buildStates.get(schemaId) ?? "idle";
}

export function getTileArchiveBuildFailure(schemaId: string): TileArchiveBuildFailure | undefined {
  return buildFailures.get(schemaId);
}

/** True while the dataset has a persistent build failure (snapshot for `useSyncExternalStore`). */
export function hasTileArchiveBuildFailure(schemaId: string): boolean {
  return buildFailures.has(schemaId);
}

/** The dataset's persistent build failure, until a build succeeds. */
export function useMapTileArchiveBuildFailure(
  schemaId: string,
): TileArchiveBuildFailure | undefined {
  return useSyncExternalStore(subscribeTileArchiveBuildState, () =>
    getTileArchiveBuildFailure(schemaId),
  );
}

/** Fetch progress of the dataset's running build, undefined when none is reported. */
export function useMapTileArchiveBuildProgress(
  schemaId: string,
): TileArchiveBuildProgress | undefined {
  return useSyncExternalStore(subscribeTileArchiveBuildState, () => buildProgress.get(schemaId));
}

/** The current build state for one dataset (`"idle"` when nothing is running). */
export function useMapTileArchiveBuildState(schemaId: string): TileArchiveBuildState {
  return useSyncExternalStore(subscribeTileArchiveBuildState, () =>
    getTileArchiveBuildState(schemaId),
  );
}

// --- Worker lifecycle + message protocol ---

let archiveWorker: Worker | undefined;
const pendingBuilds = new Map<
  string,
  { reject: (error: Error) => void; resolve: (outcome: TileArchiveBuildOutcome) => void }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The current session's Supabase access token, for the tile worker's own
 * `createClient` (a worker has neither cookies nor the provider's storage —
 * it asks the main thread, exactly like the Convex JWT handshake). Never
 * rejects: null when signed out or the read fails, so a request never hangs
 * and the PG build fails loudly on the missing identity instead of silently
 * reading zero RLS-visible rows.
 */
async function fetchSupabaseAccessToken(): Promise<string | null> {
  try {
    const { data } = await sharedClient().auth.getSession();
    const session = data.session;
    if (session === null || session === undefined) {
      return null;
    }
    return typeof session.access_token === "string" ? session.access_token : null;
  } catch {
    return null;
  }
}

/**
 * Answers the worker's token requests on the same message channel the build
 * protocol rides: the worker's standalone ConvexClient authenticates through
 * here (its `setAuth` fetcher), since the sign-in gate (roadmap 0.1) rejects
 * every unauthenticated data call — and stage 2's PG build path authenticates
 * its own `createClient` the same way (source: "supabase"). Both fetchers
 * never reject — null when signed out or the fetch fails — so a request
 * never hangs.
 */
async function replyToken(requestId: number, source: TileTokenSource): Promise<void> {
  const worker = archiveWorker;
  if (worker === undefined) return;
  const token = source === "supabase" ? await fetchSupabaseAccessToken() : await fetchConvexToken();
  // `Worker.postMessage` takes (message, transfer) — there is no
  // `targetOrigin` parameter to pass at the worker boundary.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage({ requestId, token, type: "token" } satisfies TileArchiveWorkerInbound);
}

/** Replies to the worker's token requests (Convex default, PG opt-in); other messages pass it by. */
function handleWorkerTokenRequest(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (!isRecord(data) || typeof data.requestId !== "number" || data.type !== "token-request") {
    return;
  }
  const source: TileTokenSource = data.source === "supabase" ? "supabase" : "convex";
  void replyToken(data.requestId, source);
}

/**
 * Refetches the PG queries a settled build changes: the install RPC runs
 * OUTSIDE the TanStack cache (there is no Convex-style push for Postgres
 * until stage 6's realtime), so without this the summaries — and with them
 * every layer-source decision and the OPFS pin feed — would stay on the
 * stale pre-build state until an unrelated refetch. Both feeds go stale
 * together on an install: the dataset summaries (`pg:datasets`, the
 * decision's fresh-candidate input) AND the signed-archive-URL metas
 * (`pg:tile-archives`, `usePgTileArchiveMetas`'s feed — its key's dataset
 * ids are unchanged by the install, so the query would keep answering "no
 * servable archive" and the OPFS pin would drop/prune until an unrelated
 * refetch otherwise). Fires for `done` (archive installed: decision flips
 * to tiles) and `stale-discarded` (the row moved under the build:
 * staleness re-evaluates).
 */
function invalidatePgQueries(): void {
  try {
    const { queryClient } = getContext();
    void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    // Prefix match: hits every ["pg:tile-archives", "metas", datasetIds]
    // key the maps page has mounted (pg-tile-archives-react.tsx).
    void queryClient.invalidateQueries({ queryKey: ["pg:tile-archives"] });
  } catch {
    // No client yet (SSR render, early mount): nothing cached to invalidate.
  }
}

/** Records a below-threshold skip against the version the worker read (kept
 * out of {@link handleWorkerMessage} for the complexity budget). */
function recordSkipMemo(data: Record<string, unknown>, schemaId: string): void {
  if (data.reason === "below-threshold" && typeof data.version === "number") {
    rememberBelowThresholdSkip(schemaId, data.version);
  }
}

/** Tells the scheduler which version a build installed, so it can drop a
 * redundant queued rebuild for the same data. */
function noteInstalledVersion(data: Record<string, unknown>, schemaId: string): void {
  if (rebuildScheduler !== undefined && typeof data.builtVersion === "number") {
    rebuildScheduler.noteInstalled(schemaId, data.builtVersion);
  }
}

/** Stores a `progress` message; a new object per update so snapshots change identity. */
function recordBuildProgress(data: Record<string, unknown>, schemaId: string): void {
  if (typeof data.done !== "number" || typeof data.total !== "number") return;
  buildProgress.set(schemaId, { done: data.done, total: data.total });
  notifyBuildListeners();
}

/** Progress is its own listener; `handleWorkerMessage` below must not read it as a terminal message. */
function handleWorkerProgress(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (isRecord(data) && data.type === "progress" && typeof data.schemaId === "string") {
    recordBuildProgress(data, data.schemaId);
  }
}

/** A build-state message (phase or terminal): has a schema id and is not a progress tick. */
function isBuildStateMessage(data: unknown): data is Record<string, unknown> {
  return isRecord(data) && typeof data.schemaId === "string" && data.type !== "progress";
}

/** Settles one terminal build message (kept out of {@link handleWorkerMessage} for the complexity budget). */
function settleTerminalBuild(
  data: Record<string, unknown>,
  schemaId: string,
  pending: { reject: (error: Error) => void; resolve: (outcome: TileArchiveBuildOutcome) => void },
): void {
  const pgDataset = isPostgresDatasetId(schemaId);
  if (data.type === "done") {
    setBuildState(schemaId, "done");
    clearBuildFailure(schemaId);
    noteInstalledVersion(data, schemaId);
    if (pgDataset) {
      invalidatePgQueries();
    }
    pending.resolve("installed");
    return;
  }
  if (data.type === "stale-discarded") {
    setBuildState(schemaId, "stale-discarded");
    if (pgDataset) {
      invalidatePgQueries();
    }
    pending.resolve("discarded");
    return;
  }
  if (data.type === "skipped") {
    // Memo first: the idle notification re-evaluates layer-source decisions,
    // which read the memo (#185).
    recordSkipMemo(data, schemaId);
    setBuildState(schemaId, "idle");
    clearBuildFailure(schemaId);
    pending.resolve("skipped");
    return;
  }
  setBuildState(schemaId, "error");
  const message = typeof data.message === "string" ? data.message : DEFAULT_FAILURE_MESSAGE;
  // Issue #71 added the toast (the one surface that follows the user
  // across pages); #184 keeps the failure on the map until a build succeeds.
  recordBuildFailure(schemaId, message);
  pending.reject(new Error(message));
}

function handleWorkerMessage(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (!isBuildStateMessage(data)) return;
  const schemaId = String(data.schemaId);
  if (data.type === "phase" && isBuildPhase(data.phase)) {
    setBuildState(schemaId, data.phase);
    return;
  }
  const pending = pendingBuilds.get(schemaId);
  if (pending === undefined) return;
  pendingBuilds.delete(schemaId);
  settleTerminalBuild(data, schemaId, pending);
}

function isBuildPhase(value: unknown): value is TileArchiveBuildPhase {
  return (
    value === "fetching" || value === "building" || value === "uploading" || value === "installing"
  );
}

function getWorker(): Worker {
  if (archiveWorker === undefined) {
    const spawned = new Worker(new URL("./tile-archive.worker.ts", import.meta.url), {
      type: "module",
    });
    spawned.addEventListener("message", handleWorkerTokenRequest);
    spawned.addEventListener("message", handleWorkerProgress);
    spawned.addEventListener("message", handleWorkerMessage);
    spawned.addEventListener("error", (event) => {
      // The worker itself died (not just one build): fail everything pending
      // so the scheduler unwedges, and respawn lazily on the next build.
      for (const [schemaId, pending] of pendingBuilds) {
        pendingBuilds.delete(schemaId);
        setBuildState(schemaId, "error");
        const message = event.message || "Tile-archive worker crashed.";
        recordBuildFailure(schemaId, message);
        pending.reject(new Error(message));
      }
      archiveWorker = undefined;
      spawned.terminate();
    });
    archiveWorker = spawned;
  }
  return archiveWorker;
}

async function buildViaWorker(schemaId: string): Promise<TileArchiveBuildOutcome> {
  setBuildState(schemaId, "scheduled");
  return await new Promise<TileArchiveBuildOutcome>((resolve, reject) => {
    pendingBuilds.set(schemaId, { reject, resolve });
    // `Worker.postMessage` takes (message, transfer) — there is no
    // `targetOrigin` parameter to pass at the worker boundary.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    getWorker().postMessage({ schemaId, type: "build" } satisfies TileArchiveWorkerInbound);
  });
}

let rebuildScheduler: TileArchiveScheduler | undefined;

function getScheduler(): TileArchiveScheduler {
  if (rebuildScheduler === undefined) {
    rebuildScheduler = new TileArchiveScheduler(buildViaWorker, undefined, {
      onBackoff: applyBackoff,
    });
    restoreStoredBackoffs(rebuildScheduler);
  }
  return rebuildScheduler;
}

// --- Triggers ---

/**
 * Mounted once at the app root: watches every geospatial dataset and
 * schedules a debounced rebuild whenever one is observably stale. The
 * stage-7 disconnect (issue #206) removed the Convex watch
 * (`api.cms.schemas.listSummaries` reactive push) alongside the provider;
 * Postgres datasets are the only watch: the store summaries, refetched by
 * `invalidatePgQueries` when a build settles (realtime cross-tab push is
 * stage 6). Correctness rides on the expectedVersion guard (the SQL edition:
 * `install_tile_archive`) — this only decides when to attempt.
 *
 * Import completions additionally call `ensureMapTileArchive` for immediacy;
 * the manager catches everything else (simplification workflows, geospatial
 * conversion, entry edits) the same way, since those paths bump
 * `mapTileCacheVersion` server-side with no client hook.
 */
export function useMapTileArchiveManager(): void {
  const pgSummaries = usePgDatasetSummaries();
  useEffect(() => {
    if (pgSummaries === undefined) return;
    const scheduler = getScheduler();
    for (const summary of pgSummaries) {
      const currentVersion = summary.mapTileCacheVersion;
      if (isPgTileArchiveStale(summary)) {
        scheduler.schedule(summary.id, currentVersion);
      } else {
        // Current without our help (another tab or user built it): drop the
        // failure and its armed retry (#184 review), which would only rebuild
        // a fresh archive.
        scheduler.clear(summary.id);
        clearBuildFailure(summary.id);
      }
    }
  }, [pgSummaries]);
}

/** Render-once app-shell component mounting the manager (renders nothing). */
export function TileArchiveManager(): null {
  useMapTileArchiveManager();
  return null;
}

/**
 * Import-UI immediacy, and the failed-build state's manual retry (issue #184):
 * skip the debounce window and any failure backoff, and start (or queue) a
 * build now. A repeat failure still escalates the backoff. Safe to call
 * speculatively — the worker no-ops for datasets the
 * threshold doesn't warrant, and part 2's guard covers races.
 */
export function ensureMapTileArchive(schemaId: string): void {
  getScheduler().ensure(schemaId);
}

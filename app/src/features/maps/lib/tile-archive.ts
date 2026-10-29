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
  isTileArchiveStale,
  rememberBelowThresholdSkip,
  TileArchiveScheduler,
  type TileArchiveBackoff,
  type TileArchiveBuildOutcome,
  type TileArchiveBuildPhase,
  type TileArchiveBuildState,
} from "@caden/maps/build-scheduler";
import { useQuery } from "convex/react";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { fetchConvexToken } from "#/lib/convex-auth-token";
import { api } from "#convex/_generated/api";

/** Main thread → worker: one build per message, plus token-fetch replies. */
export type TileArchiveWorkerInbound =
  | { schemaId: string; type: "build" }
  | { requestId: number; token: string | null; type: "token" };

/** Worker → main thread: token requests, transient `phase` messages, then one terminal message. */
export type TileArchiveWorkerOutbound =
  | { requestId: number; type: "token-request" }
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
 * Answers the worker's token requests on the same message channel the build
 * protocol rides: the worker's standalone ConvexClient authenticates through
 * here (its `setAuth` fetcher), since the sign-in gate (roadmap 0.1) rejects
 * every unauthenticated data call. `fetchConvexToken` never rejects — null
 * when signed out or the fetch fails — so a request never hangs.
 */
async function replyToken(requestId: number): Promise<void> {
  const worker = archiveWorker;
  if (worker === undefined) return;
  const token = await fetchConvexToken();
  // `Worker.postMessage` takes (message, transfer) — there is no
  // `targetOrigin` parameter to pass at the worker boundary.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage({ requestId, token, type: "token" } satisfies TileArchiveWorkerInbound);
}

/** Replies to the worker's Convex-token requests; other messages pass it by. */
function handleWorkerTokenRequest(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (!isRecord(data) || typeof data.requestId !== "number" || data.type !== "token-request") {
    return;
  }
  void replyToken(data.requestId);
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
  if (data.type === "done") {
    setBuildState(schemaId, "done");
    clearBuildFailure(schemaId);
    noteInstalledVersion(data, schemaId);
    pending.resolve("installed");
  } else if (data.type === "stale-discarded") {
    setBuildState(schemaId, "stale-discarded");
    pending.resolve("discarded");
  } else if (data.type === "skipped") {
    // Memo first: the idle notification re-evaluates layer-source decisions,
    // which read the memo (#185).
    recordSkipMemo(data, schemaId);
    setBuildState(schemaId, "idle");
    clearBuildFailure(schemaId);
    pending.resolve("skipped");
  } else {
    setBuildState(schemaId, "error");
    const message = typeof data.message === "string" ? data.message : DEFAULT_FAILURE_MESSAGE;
    // Issue #71 added the toast (the one surface that follows the user
    // across pages); #184 keeps the failure on the map until a build succeeds.
    recordBuildFailure(schemaId, message);
    pending.reject(new Error(message));
  }
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
 * schedules a debounced rebuild whenever one is observably stale. Correctness
 * rides on part 2's guard — this only decides when to attempt.
 *
 * Import completions additionally call `ensureMapTileArchive` for immediacy;
 * the manager catches everything else (simplification workflows, geospatial
 * conversion, entry edits) the same way, since those paths bump
 * `mapTileCacheVersion` server-side with no client hook.
 */
export function useMapTileArchiveManager(): void {
  const schemas = useQuery(api.cms.schemas.listSummaries, { limit: 1000 });
  useEffect(() => {
    if (schemas === undefined) return;
    const scheduler = getScheduler();
    for (const schema of schemas) {
      const currentVersion = schema.mapTileCacheVersion ?? 0;
      if (isTileArchiveStale(schema, currentVersion)) {
        scheduler.schedule(schema._id, currentVersion);
      } else {
        // Current without our help (another tab or user built it): drop the
        // failure and its armed retry, which would only rebuild a fresh
        // archive (#184 review).
        scheduler.clear(schema._id);
        clearBuildFailure(schema._id);
      }
    }
  }, [schemas]);
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

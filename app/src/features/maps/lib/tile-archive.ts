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
const buildRevertTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Terminal states flash briefly, then the indicator returns to idle. */
const BUILD_STATE_REVERT_MS = 4_000;

function setBuildState(schemaId: string, state: TileArchiveBuildState): void {
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
  for (const listener of buildListeners) listener();
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

function handleWorkerMessage(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (!isRecord(data) || typeof data.schemaId !== "string") return;
  const { schemaId } = data;
  if (data.type === "phase" && isBuildPhase(data.phase)) {
    setBuildState(schemaId, data.phase);
    return;
  }
  const pending = pendingBuilds.get(schemaId);
  if (pending === undefined) return;
  pendingBuilds.delete(schemaId);
  if (data.type === "done") {
    setBuildState(schemaId, "done");
    pending.resolve("installed");
  } else if (data.type === "stale-discarded") {
    setBuildState(schemaId, "stale-discarded");
    pending.resolve("discarded");
  } else if (data.type === "skipped") {
    setBuildState(schemaId, "idle");
    recordSkipMemo(data, schemaId);
    pending.resolve("skipped");
  } else {
    setBuildState(schemaId, "error");
    const message = typeof data.message === "string" ? data.message : "Tile-archive build failed.";
    // Issue #71: a failed build used to flash an in-memory state nothing
    // rendered — users never saw it. The toast persists past the 4s state
    // revert and is the one surface that follows the user across pages.
    toast.error(`Tile rebuild failed (${schemaId.slice(-6)}): ${message}`);
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
    spawned.addEventListener("message", handleWorkerMessage);
    spawned.addEventListener("error", (event) => {
      // The worker itself died (not just one build): fail everything pending
      // so the scheduler unwedges, and respawn lazily on the next build.
      for (const [schemaId, pending] of pendingBuilds) {
        pendingBuilds.delete(schemaId);
        setBuildState(schemaId, "error");
        const message = event.message || "Tile-archive worker crashed.";
        toast.error(`Tile rebuild failed (${schemaId.slice(-6)}): ${message}`);
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
  rebuildScheduler ??= new TileArchiveScheduler(buildViaWorker);
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
  const schemas = useQuery(api.schemas.listSummaries, { limit: 1000 });
  useEffect(() => {
    if (schemas === undefined) return;
    const scheduler = getScheduler();
    for (const schema of schemas) {
      const currentVersion = schema.mapTileCacheVersion ?? 0;
      if (isTileArchiveStale(schema, currentVersion)) {
        scheduler.schedule(schema._id, currentVersion);
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
 * Import-UI immediacy: skip the debounce window and start (or queue) a build
 * now. Safe to call speculatively — the worker no-ops for datasets the
 * threshold doesn't warrant, and part 2's guard covers races.
 */
export function ensureMapTileArchive(schemaId: string): void {
  getScheduler().ensure(schemaId);
}

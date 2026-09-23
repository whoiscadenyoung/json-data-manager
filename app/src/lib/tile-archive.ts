/**
 * Tile-archive rebuild manager (issue #58 part 3) — decides WHEN a dataset's
 * tile archive gets rebuilt and runs exactly one build at a time per dataset.
 * The build itself runs in {@link ./tile-archive.worker.ts} (a web worker that
 * owns a standalone ConvexClient): one build = one message round trip.
 *
 * Correctness does NOT live here. A rebuild races edits by design; part 2's
 * `setMapTileArchive` `expectedVersion` guard makes a build that started
 * against stale data self-discarding, so this module only needs to keep
 * *scheduling* until the schema's `mapTileCacheVersion` has a matching
 * archive installed. Single-flight + a trailing debounce keep bursts (an
 * N-chunk import bumps the version N times) to one build.
 */
import { useQuery } from "convex/react";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { api } from "#convex/_generated/api";
import { fetchConvexToken } from "#/lib/convex-auth-token";

/** Transient phases the worker posts while a build runs. */
export type TileArchiveBuildPhase = "fetching" | "building" | "uploading" | "installing";

/** What the worker's terminal message tells the manager the install did. */
export type TileArchiveBuildOutcome = "installed" | "discarded" | "skipped";

/** Per-dataset build state, observable for a subtle UI indicator (part 4). */
export type TileArchiveBuildState =
  | TileArchiveBuildPhase
  | "idle"
  | "scheduled"
  | "done"
  | "stale-discarded"
  | "error";

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
  | { reason: "not-geospatial" | "below-threshold"; schemaId: string; type: "skipped" }
  | { message: string; schemaId: string; type: "error" };

/** Starts one build for a dataset; resolves with its terminal outcome. */
export type StartTileArchiveBuild = (schemaId: string) => Promise<TileArchiveBuildOutcome>;

/**
 * Minimum geometry-payload bytes an archive is worth building for. Keep in
 * sync with `MAP_TILE_ARCHIVE_MIN_BYTES` in the component's `lib.ts` (the
 * authoritative constant lives there; this module can't import backend code,
 * and the worker applies the exact check after assembling the payload).
 */
export const MAP_TILE_ARCHIVE_MIN_BYTES = 262_144; // 256 KB

/** Trailing-debounce window: a burst of edits rebuilds once, 5 s after the last. */
const REBUILD_DEBOUNCE_MS = 5_000;

/**
 * Trailing-debounced, single-flight-per-schema rebuild scheduler.
 *
 * `schedule(schemaId, version)` debounces by version: a newer version resets
 * the window, an equal-or-older one keeps the pending timer. A trigger that
 * arrives while a build is in flight is queued (at most one queued rebuild —
 * the running build either installs its snapshot and makes the queue moot, or
 * self-discards and the queued rebuild runs against the newer data). Builds
 * resolve/throw per outcome; a thrown build never wedges the scheduler.
 */
export class TileArchiveScheduler {
  readonly #startBuild: StartTileArchiveBuild;
  readonly #debounceMs: number;
  readonly #timers = new Map<string, { id: ReturnType<typeof setTimeout>; version: number }>();
  readonly #inFlight = new Map<string, number>();
  readonly #queued = new Map<string, number>();

  constructor(startBuild: StartTileArchiveBuild, debounceMs = REBUILD_DEBOUNCE_MS) {
    this.#startBuild = startBuild;
    this.#debounceMs = debounceMs;
  }

  schedule(schemaId: string, version: number): void {
    if (this.#inFlight.has(schemaId)) {
      this.#queueNewer(schemaId, version);
      return;
    }
    const pending = this.#timers.get(schemaId);
    if (pending) {
      if (pending.version >= version) return;
      clearTimeout(pending.id);
    }
    this.#timers.set(schemaId, {
      id: setTimeout(() => {
        this.#fire(schemaId, version);
      }, this.#debounceMs),
      version,
    });
  }

  /**
   * Skips the debounce window: starts a build now, or (when one is already
   * running) queues an immediate follow-up so the trigger isn't lost.
   */
  ensure(schemaId: string): void {
    const pending = this.#timers.get(schemaId);
    if (pending) {
      clearTimeout(pending.id);
      this.#timers.delete(schemaId);
    }
    if (this.#inFlight.has(schemaId)) {
      this.#queueNewer(schemaId, Number.POSITIVE_INFINITY);
      return;
    }
    this.#run(schemaId, 0);
  }

  dispose(): void {
    for (const { id } of this.#timers.values()) {
      clearTimeout(id);
    }
    this.#timers.clear();
  }

  #queueNewer(schemaId: string, version: number): void {
    const existing = this.#queued.get(schemaId);
    if (existing !== undefined && (existing === Number.POSITIVE_INFINITY || existing >= version)) {
      return;
    }
    this.#queued.set(schemaId, version);
  }

  #fire(schemaId: string, version: number): void {
    this.#timers.delete(schemaId);
    if (this.#inFlight.has(schemaId)) {
      this.#queueNewer(schemaId, version);
      return;
    }
    this.#run(schemaId, version);
  }

  #run(schemaId: string, version: number): void {
    this.#inFlight.set(schemaId, version);
    void this.#startBuild(schemaId)
      .catch(() => undefined)
      .finally(() => {
        if (this.#inFlight.get(schemaId) === version) {
          this.#inFlight.delete(schemaId);
        }
        const queued = this.#queued.get(schemaId);
        if (queued !== undefined) {
          this.#queued.delete(schemaId);
          // The queued rebuild starts without another debounce wait: it
          // already trailed a full window behind the burst, and the worker
          // re-reads the live version when it starts.
          this.#run(schemaId, queued);
        }
      });
  }
}

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

/** The schema fields the staleness check reads off `listSchemas` rows. */
interface TileArchiveSchemaRow {
  _id: string;
  geometryType?: string;
  kind?: "standard" | "geospatial";
  mapTileArchiveBuiltVersion?: number;
  mapTileArchiveStorageId?: string;
  mapTileCacheVersion?: number;
}

/**
 * True when a dataset deserves a (re)build: geospatial with at least one
 * geometry-affecting write, and either no installed archive (first build —
 * covers imports that skipped the ensure-call, geospatial conversion, and
 * datasets that grew past the threshold after import) or an installed one
 * built behind the current version (stale-on-view — the authoritative,
 * self-healing trigger).
 */
function isTileArchiveStale(schema: TileArchiveSchemaRow, currentVersion: number): boolean {
  if (schema.kind !== "geospatial" || schema.geometryType === undefined) return false;
  if (currentVersion === 0) return false; // never had a geometry write
  if (schema.mapTileArchiveStorageId === undefined) return true;
  return (schema.mapTileArchiveBuiltVersion ?? 0) !== currentVersion;
}

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
  const schemas = useQuery(api.schemas.listSummaries);
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

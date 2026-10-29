/**
 * Tile-archive rebuild scheduling, independent of any backend (issue #58
 * part 3): the debounced single-flight scheduler, the build-state types, and
 * the staleness check that decides whether a dataset needs a (re)build. The
 * app's manager (`features/maps/lib/tile-archive.ts`) feeds it live schema
 * rows and runs builds in its worker.
 */

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
 * Failure backoff (issue #184): the automatic retry after the 1st, 2nd and
 * 3rd+ consecutive failed build at one `mapTileCacheVersion`. The last step
 * repeats, so a dataset that never builds costs one attempt per 30 m instead
 * of one per summaries update.
 */
export const TILE_ARCHIVE_FAILURE_BACKOFF_MS: readonly number[] = [60_000, 300_000, 1_800_000];

/** A dataset's failure backoff, reported through `onBackoff`. */
export interface TileArchiveBackoff {
  /** Consecutive failed builds at the current version. */
  failures: number;
  /** Epoch ms when the automatic retry fires. */
  retryAt: number;
  /** The `mapTileCacheVersion` the failures happened at; a newer one resets. */
  version: number;
}

export interface TileArchiveSchedulerOptions {
  /** Retry delays per consecutive failure; the last entry repeats. */
  backoffMs?: readonly number[];
  /**
   * Called when a failure starts a backoff window, and with `undefined` when
   * the backoff ends early: a build succeeded or a newer version reset it.
   */
  onBackoff?: (schemaId: string, backoff: TileArchiveBackoff | undefined) => void;
}

/**
 * Trailing-debounced, single-flight-per-schema rebuild scheduler.
 *
 * `schedule(schemaId, version)` debounces by version: a newer version resets
 * the window, an equal-or-older one keeps the pending timer. A trigger that
 * arrives while a build is in flight is queued (at most one queued rebuild —
 * the running build either installs its snapshot and makes the queue moot, or
 * self-discards and the queued rebuild runs against the newer data). Builds
 * resolve/throw per outcome; a thrown build never wedges the scheduler.
 *
 * A thrown build backs off (issue #184): `schedule` triggers at the failed
 * version are absorbed until the backoff's own retry timer fires, so a
 * failing dataset is attempted at most once per window. A newer version
 * resets the backoff (the data changed, so the failure may not recur);
 * `ensure` skips the remaining wait but keeps the failure count. The
 * scheduler lives in memory; `restoreBackoff` re-arms a window a caller
 * persisted, so a page reload doesn't buy a failing dataset a fresh attempt.
 */
export class TileArchiveScheduler {
  readonly #startBuild: StartTileArchiveBuild;
  readonly #debounceMs: number;
  readonly #timers = new Map<string, { id: ReturnType<typeof setTimeout>; version: number }>();
  readonly #inFlight = new Map<string, number>();
  readonly #queued = new Map<string, number>();
  readonly #backoffMs: readonly number[];
  readonly #onBackoff: NonNullable<TileArchiveSchedulerOptions["onBackoff"]>;
  /** Newest version `schedule` has seen per schema (0 until the first). */
  readonly #versions = new Map<string, number>();
  /** Consecutive failures and the version they happened at. */
  readonly #failures = new Map<string, { count: number; version: number }>();
  /** Newest version a build installed per schema (issue #195 item 1). */
  readonly #installed = new Map<string, number>();
  /** Pending backoff retries; presence means "backing off". */
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #disposed = false;

  constructor(
    startBuild: StartTileArchiveBuild,
    debounceMs = REBUILD_DEBOUNCE_MS,
    options: TileArchiveSchedulerOptions = {},
  ) {
    this.#startBuild = startBuild;
    this.#debounceMs = debounceMs;
    this.#backoffMs = options.backoffMs ?? TILE_ARCHIVE_FAILURE_BACKOFF_MS;
    this.#onBackoff = options.onBackoff ?? (() => undefined);
  }

  schedule(schemaId: string, version: number): void {
    this.#noteVersion(schemaId, version);
    if (this.#retryTimers.has(schemaId)) return;
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
    this.#clearRetryTimer(schemaId);
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

  /**
   * Drops a dataset's failure backoff, for when its archive turned current
   * some other way (another tab or user built it): the armed retry would
   * only rebuild an archive that is already fresh.
   */
  clear(schemaId: string): void {
    const hadRetry = this.#clearRetryTimer(schemaId);
    if (this.#failures.delete(schemaId) || hadRetry) {
      this.#onBackoff(schemaId, undefined);
    }
  }

  /** Cancels pending timers; a build still in flight settles without arming any. */
  dispose(): void {
    this.#disposed = true;
    for (const { id } of this.#timers.values()) {
      clearTimeout(id);
    }
    this.#timers.clear();
    for (const id of this.#retryTimers.values()) {
      clearTimeout(id);
    }
    this.#retryTimers.clear();
  }

  /**
   * Re-arms a backoff persisted from an earlier `onBackoff` (for example
   * across a page reload). The retry fires at `retryAt`, or right away if
   * that has passed. Ignored while the dataset is building or backing off.
   */
  restoreBackoff(schemaId: string, backoff: TileArchiveBackoff): void {
    if (this.#inFlight.has(schemaId) || this.#retryTimers.has(schemaId)) return;
    this.#failures.set(schemaId, { count: backoff.failures, version: backoff.version });
    this.#versions.set(schemaId, Math.max(this.#versions.get(schemaId) ?? 0, backoff.version));
    this.#armRetry(schemaId, backoff.version, Math.max(0, backoff.retryAt - Date.now()));
  }

  /**
   * Records that a build installed an archive at `version`. A queued or
   * debounced trigger for that version or older is then redundant: the data
   * it would rebuild is already covered, so it is dropped instead of running
   * a second full fetch-and-build right behind the first.
   */
  noteInstalled(schemaId: string, version: number): void {
    if (version > (this.#installed.get(schemaId) ?? 0)) {
      this.#installed.set(schemaId, version);
    }
  }

  #isCovered(schemaId: string, version: number): boolean {
    // Version 0 means "unknown" (an `ensure` before any `schedule`): never covered.
    return version > 0 && version <= (this.#installed.get(schemaId) ?? 0);
  }

  /** Tracks the newest version and resets the backoff when it moves past the failed one. */
  #noteVersion(schemaId: string, version: number): void {
    if (version <= (this.#versions.get(schemaId) ?? 0)) return;
    this.#versions.set(schemaId, version);
    const failure = this.#failures.get(schemaId);
    if (failure === undefined || version <= failure.version) return;
    if (failure.version === 0) {
      // The failure came from an `ensure` before any `schedule` reported a
      // version. The first one seen is what that build read: adopt it, or
      // the very next trigger would wipe the backoff it just earned.
      this.#failures.set(schemaId, { count: failure.count, version });
      return;
    }
    this.#failures.delete(schemaId);
    if (this.#clearRetryTimer(schemaId)) {
      this.#onBackoff(schemaId, undefined);
    }
  }

  /** Cancels a pending backoff retry; true when one was pending. */
  #clearRetryTimer(schemaId: string): boolean {
    const retry = this.#retryTimers.get(schemaId);
    if (retry === undefined) return false;
    clearTimeout(retry);
    this.#retryTimers.delete(schemaId);
    return true;
  }

  #recordFailure(schemaId: string, version: number): void {
    const previous = this.#failures.get(schemaId),
      count = previous !== undefined && previous.version === version ? previous.count + 1 : 1,
      delay = this.#backoffMs.at(Math.min(count, this.#backoffMs.length) - 1) ?? 0;
    this.#failures.set(schemaId, { count, version });
    this.#armRetry(schemaId, version, delay);
    this.#onBackoff(schemaId, { failures: count, retryAt: Date.now() + delay, version });
  }

  #armRetry(schemaId: string, version: number, delay: number): void {
    this.#retryTimers.set(
      schemaId,
      setTimeout(() => {
        this.#retryTimers.delete(schemaId);
        this.#fire(schemaId, version);
      }, delay),
    );
  }

  #recordSuccess(schemaId: string): void {
    if (this.#failures.delete(schemaId)) {
      this.#onBackoff(schemaId, undefined);
    }
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
    if (this.#isCovered(schemaId, version)) return;
    if (this.#inFlight.has(schemaId)) {
      this.#queueNewer(schemaId, version);
      return;
    }
    this.#run(schemaId, version);
  }

  #run(schemaId: string, version: number): void {
    this.#inFlight.set(schemaId, version);
    void this.#track(schemaId, version, this.#versions.get(schemaId) ?? 0);
  }

  async #track(schemaId: string, version: number, startedAt: number): Promise<void> {
    let failed = false;
    try {
      await this.#startBuild(schemaId);
      this.#recordSuccess(schemaId);
    } catch {
      failed = true;
    }
    this.#settle(schemaId, version, startedAt, failed);
  }

  #settle(schemaId: string, version: number, startedAt: number, failed: boolean): void {
    if (this.#inFlight.get(schemaId) === version) {
      this.#inFlight.delete(schemaId);
    }
    if (this.#disposed) return;
    const queued = this.#queued.get(schemaId);
    this.#queued.delete(schemaId);
    // After a failure, only newer data earns an immediate rebuild; anything
    // else waits out the backoff like a fresh trigger would.
    const newerData = (this.#versions.get(schemaId) ?? 0) > startedAt;
    if (queued !== undefined && !this.#isCovered(schemaId, queued) && (!failed || newerData)) {
      // The queued rebuild starts without another debounce wait: it
      // already trailed a full window behind the burst, and the worker
      // re-reads the live version when it starts.
      this.#run(schemaId, queued);
      return;
    }
    if (failed) {
      this.#recordFailure(schemaId, startedAt);
    }
  }
}

/** The schema fields the staleness check reads off `listSchemas` rows. */
export interface TileArchiveSchemaRow {
  _id: string;
  geometryType?: string;
  kind?: "standard" | "geospatial";
  mapTileArchiveBuiltVersion?: number;
  /** Derived issue #125 gate flag the summary projection computes server-side. */
  mapTileArchiveFormatCurrent?: boolean;
  mapTileCacheVersion?: number;
}

/**
 * The below-threshold skip memo (issue #134): schemaId → `skipped:<version>`,
 * recorded when a build fetched the dataset's full geometry payload and the
 * worker ended `below-threshold` at that version. A dataset under the 256 KB
 * threshold never installs an archive, so without the memo
 * `mapTileArchiveBuiltVersion` stays absent and every `listSummaries` update
 * reads the dataset as stale — a debounced full fetch-and-skip round trip
 * forever. A later version bump stops matching the memo and scheduling
 * resumes: the dataset may have grown past the threshold.
 */
const belowThresholdSkips = new Map<string, string>();

/** Records that a build ended `below-threshold` at `version` (worker →
 * manager message path; exported for the memo tests). */
export function rememberBelowThresholdSkip(schemaId: string, version: number): void {
  belowThresholdSkips.set(schemaId, `skipped:${version}`);
}

/** True when the current version is exactly the one a build already skipped
 * as below-threshold (exported for the memo tests). */
export function isBelowThresholdSkipMemoized(schemaId: string, version: number): boolean {
  return belowThresholdSkips.get(schemaId) === `skipped:${version}`;
}

/**
 * True when a dataset deserves a (re)build: geospatial with at least one
 * geometry-affecting write, and either no installed archive (first build —
 * covers imports that skipped the ensure-call, geospatial conversion, and
 * datasets that grew past the threshold after import), an installed one the
 * archive-FORMAT gate rejects (issue #125: built by an older builder whose
 * run-length dedupe could merge across tile-id gaps, so `getMapTileArchiveMeta`
 * serves it as null until a fresh install stamps the current format), or an
 * installed one built behind the current version (stale-on-view — the
 * authoritative, self-healing trigger). `mapTileArchiveBuiltVersion` is set
 * iff an archive ever installed (the summaries carry no storage id since
 * #131), so its absence is the "no archive yet" signal — except when the
 * current version already ended `below-threshold`, which the skip memo
 * absorbs.
 *
 * Exported for tests; the app's `useMapTileArchiveManager` is the production caller.
 */
export function isTileArchiveStale(schema: TileArchiveSchemaRow, currentVersion: number): boolean {
  if (schema.kind !== "geospatial" || schema.geometryType === undefined) return false;
  if (currentVersion === 0) return false; // never had a geometry write
  if (isBelowThresholdSkipMemoized(schema._id, currentVersion)) return false;
  if (schema.mapTileArchiveBuiltVersion === undefined) return true;
  // The gate rides the summary as a boolean computed NEXT TO the component's
  // `MAP_TILE_ARCHIVE_FORMAT` constant — this module deliberately keeps no
  // copy of the constant (drift would loop rebuilds). Absent — not merely
  // false — means the row predates the flag (an older backend still serving
  // the old projection shape, which has no format gate either): fall through
  // to the built-version check instead of invalidating on it.
  if (schema.mapTileArchiveFormatCurrent === false) return true;
  return schema.mapTileArchiveBuiltVersion !== currentVersion;
}

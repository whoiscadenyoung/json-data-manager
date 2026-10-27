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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TileArchiveScheduler,
  isBelowThresholdSkipMemoized,
  isTileArchiveStale,
  rememberBelowThresholdSkip,
  type TileArchiveBuildOutcome,
} from "./tile-archive";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type BuildDeferral = ReturnType<typeof deferred<TileArchiveBuildOutcome>>;

/** A build starter whose builds settle only when the test releases them. */
function deferredStartBuild(): {
  calls: Array<BuildDeferral>;
  startBuild: (schemaId: string) => Promise<TileArchiveBuildOutcome>;
} {
  const calls: Array<BuildDeferral> = [];
  return {
    calls,
    startBuild: vi.fn<(schemaId: string) => Promise<TileArchiveBuildOutcome>>(async (_schemaId) => {
      const deferral = deferred<TileArchiveBuildOutcome>();
      calls.push(deferral);
      return await deferral.promise;
    }),
  };
}

/** The settled-then-queued-rebuild chain crosses five promise hops. */
function firstDeferral(calls: Array<BuildDeferral>, index: number): BuildDeferral {
  const deferral = calls[index];
  if (deferral === undefined) {
    throw new Error(`build ${index} never started`);
  }
  return deferral;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TileArchiveScheduler", () => {
  it("coalesces a burst of version bumps into one trailing build", async () => {
    const { startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.schedule("s1", 1);
      scheduler.schedule("s1", 2);
      scheduler.schedule("s1", 3);

      await vi.advanceTimersByTimeAsync(4999);
      expect(startBuild).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(startBuild).toHaveBeenCalledTimes(1);

      // The burst is over: nothing more fires even long after.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(startBuild).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.dispose();
    }
  });

  it("keeps the newest pending version — an older trigger does not reset the window", async () => {
    const { startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(4999);
      scheduler.schedule("s1", 2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(startBuild).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.dispose();
    }
  });

  it("queues edits landing mid-build and rebuilds once the build self-discards", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.schedule("s1", 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(1);

      // Edits during the build are queued, never a second concurrent build.
      scheduler.schedule("s1", 2);
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(startBuild).toHaveBeenCalledTimes(1);

      // The build self-discards (edits landed): the queued rebuild starts
      // immediately — no second debounce wait.
      firstDeferral(calls, 0).resolve("discarded");
      await flushMicrotasks();
      expect(startBuild).toHaveBeenCalledTimes(2);

      // The queued rebuild converges; nothing further fires.
      firstDeferral(calls, 1).resolve("installed");
      await flushMicrotasks();
      expect(startBuild).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });

  it("ensure() skips the debounce window and starts immediately", async () => {
    const { startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.schedule("s1", 1);
      await vi.advanceTimersByTimeAsync(1000);
      scheduler.ensure("s1");
      expect(startBuild).toHaveBeenCalledTimes(1);

      // The superseded timer is gone: letting it elapse fires nothing further.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(startBuild).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.dispose();
    }
  });

  it("ensure() during an in-flight build queues an immediate follow-up", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.ensure("s1");
      expect(startBuild).toHaveBeenCalledTimes(1);

      scheduler.ensure("s1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(startBuild).toHaveBeenCalledTimes(1);

      firstDeferral(calls, 0).resolve("skipped");
      await flushMicrotasks();
      expect(startBuild).toHaveBeenCalledTimes(2);

      firstDeferral(calls, 1).resolve("installed");
      await flushMicrotasks();
      expect(startBuild).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });

  it("a failed build does not wedge single-flight", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.schedule("s1", 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(1);

      // The first build fails; the scheduler must accept the next trigger.
      firstDeferral(calls, 0).reject(new Error("boom"));
      await flushMicrotasks();

      scheduler.schedule("s1", 2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(2);

      firstDeferral(calls, 1).resolve("installed");
      await flushMicrotasks();
      expect(startBuild).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });

  it("schedules independent datasets concurrently", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000);
    try {
      scheduler.schedule("a", 1);
      scheduler.schedule("b", 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(2);
      expect(startBuild).toHaveBeenCalledWith("a");
      expect(startBuild).toHaveBeenCalledWith("b");

      firstDeferral(calls, 0).resolve("installed");
      firstDeferral(calls, 1).resolve("installed");
      await flushMicrotasks();
    } finally {
      scheduler.dispose();
    }
  });
});

/**
 * The below-threshold skip memo (issue #134): a dataset under the 256 KB
 * threshold never installs an archive, so without the memo its absent
 * `mapTileArchiveBuiltVersion` reads as stale on every summaries update and
 * each one schedules another full fetch-and-skip round trip.
 */
/** A summaries row for the memo tests: geospatial, current version 3, with
 * `mapTileArchiveBuiltVersion` only when an archive ever installed. */
const memoRow = (schemaId: string, builtVersion?: number) => ({
  _id: schemaId,
  geometryType: "Point",
  kind: "geospatial" as const,
  mapTileCacheVersion: 3,
  ...(builtVersion === undefined ? {} : { mapTileArchiveBuiltVersion: builtVersion }),
});

describe("below-threshold skip memo", () => {
  it("a memoized skip at the current version is not stale, archive or not", () => {
    rememberBelowThresholdSkip("memo-s1", 3);
    expect(isBelowThresholdSkipMemoized("memo-s1", 3)).toBe(true);
    expect(isTileArchiveStale(memoRow("memo-s1"), 3)).toBe(false);
    expect(isTileArchiveStale(memoRow("memo-s1", 1), 3)).toBe(false);
  });

  it("a version bump stops matching the memo and is stale again", () => {
    rememberBelowThresholdSkip("memo-s2", 3);
    expect(isTileArchiveStale(memoRow("memo-s2"), 4)).toBe(true);
    // And the newer version is not itself memoized.
    expect(isBelowThresholdSkipMemoized("memo-s2", 4)).toBe(false);
  });

  it("an unmemoized dataset behaves exactly as before", () => {
    expect(isBelowThresholdSkipMemoized("memo-s3", 3)).toBe(false);
    // No archive ever built → stale (the first-build trigger).
    expect(isTileArchiveStale(memoRow("memo-s3"), 3)).toBe(true);
    // Archive built at the current version → fresh.
    expect(isTileArchiveStale(memoRow("memo-s3", 3), 3)).toBe(false);
    // Archive built behind → stale (the stale-on-view trigger).
    expect(isTileArchiveStale(memoRow("memo-s3", 2), 3)).toBe(true);
  });
});

describe("isTileArchiveStale", () => {
  const geospatial = {
    _id: "s1",
    geometryType: "Point",
    kind: "geospatial" as const,
  };

  it("a format-gated archive is stale even though its built-at version matches (issue #125)", () => {
    // The exact pre-fix hole: a pre-#125 row's archive fields all look
    // current, but its blob was written by the gap-merging format-1 builder
    // and getMapTileArchiveMeta refuses to serve it — the manager must
    // rebuild it rather than wait for an edit that may never come.
    expect(
      isTileArchiveStale(
        {
          ...geospatial,
          mapTileArchiveBuiltVersion: 3,
          // Derived server-side by the summary projection: false = the row's
          // stored format field is absent/behind MAP_TILE_ARCHIVE_FORMAT.
          mapTileArchiveFormatCurrent: false,
          mapTileCacheVersion: 3,
        },
        3,
      ),
    ).toBe(true);
  });

  it("an archive at the current version and current format is not stale", () => {
    expect(
      isTileArchiveStale(
        {
          ...geospatial,
          mapTileArchiveBuiltVersion: 3,
          mapTileArchiveFormatCurrent: true,
          mapTileCacheVersion: 3,
        },
        3,
      ),
    ).toBe(false);
  });

  it("an absent format flag (pre-flag summary shape) falls through to the built-version check", () => {
    // Version-skew safety: a backend older than the flag has no format gate
    // either, so treating the missing flag as stale would loop rebuilds.
    expect(
      isTileArchiveStale(
        {
          ...geospatial,
          mapTileArchiveBuiltVersion: 3,
          mapTileCacheVersion: 3,
        },
        3,
      ),
    ).toBe(false);
  });

  it("still fires the first-build and stale-on-view triggers", () => {
    expect(isTileArchiveStale({ ...geospatial, mapTileCacheVersion: 1 }, 1)).toBe(true);
    expect(
      isTileArchiveStale(
        {
          ...geospatial,
          mapTileArchiveBuiltVersion: 1,
          mapTileArchiveFormatCurrent: true,
          mapTileCacheVersion: 2,
        },
        2,
      ),
    ).toBe(true);
  });

  it("ignores never-written, non-geospatial, and geometry-less rows", () => {
    expect(
      isTileArchiveStale({ ...geospatial, mapTileArchiveFormatCurrent: false }, 0),
    ).toBe(false);
    expect(isTileArchiveStale({ ...geospatial, kind: "standard", mapTileCacheVersion: 1 }, 1)).toBe(
      false,
    );
    expect(isTileArchiveStale({ _id: "s2", kind: "geospatial", mapTileCacheVersion: 1 }, 1)).toBe(
      false,
    );
  });
});

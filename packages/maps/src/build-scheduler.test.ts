import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TileArchiveScheduler,
  isBelowThresholdSkipMemoized,
  isTileArchiveStale,
  rememberBelowThresholdSkip,
  type TileArchiveBuildOutcome,
  type TileArchiveSchedulerOptions,
} from "./build-scheduler";

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

type OnBackoff = NonNullable<TileArchiveSchedulerOptions["onBackoff"]>;

describe("TileArchiveScheduler failure backoff (issue #184)", () => {
  const backoffMs = [60_000, 300_000, 1_800_000];

  /** Fails build `index`, letting the settle chain record the backoff. */
  async function failBuild(calls: Array<BuildDeferral>, index: number): Promise<void> {
    firstDeferral(calls, index).reject(new Error("listGeometries timed out"));
    await flushMicrotasks();
  }

  it("absorbs triggers at the failed version until the backoff expires, then retries once", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(1);
      await failBuild(calls, 0);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 1,
        retryAt: Date.now() + 60_000,
        version: 3,
      });

      // Every dataset view / summaries update re-schedules the stale dataset:
      // none of them starts a build inside the window.
      for (let second = 0; second < 59; second += 1) {
        scheduler.schedule("s1", 3);
        // oxlint-disable-next-line no-await-in-loop -- one re-trigger per simulated second of views.
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(startBuild).toHaveBeenCalledTimes(1);

      // The window ends: exactly one automatic retry.
      await vi.advanceTimersByTimeAsync(1000);
      expect(startBuild).toHaveBeenCalledTimes(2);
      firstDeferral(calls, 1).resolve("installed");
      await flushMicrotasks();
      expect(onBackoff).toHaveBeenLastCalledWith("s1", undefined);
    } finally {
      scheduler.dispose();
    }
  });

  it("escalates 1 m → 5 m → 30 m and repeats the last step", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      /** Fails build `index` and checks the retry waits exactly `delay`. */
      const expectRetryAfter = async (index: number, delay: number): Promise<void> => {
        await failBuild(calls, index);
        expect(onBackoff).toHaveBeenLastCalledWith("s1", {
          failures: index + 1,
          retryAt: Date.now() + delay,
          version: 0,
        });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(startBuild).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(startBuild).toHaveBeenCalledTimes(index + 2);
      };
      scheduler.ensure("s1");
      await expectRetryAfter(0, 60_000);
      await expectRetryAfter(1, 300_000);
      await expectRetryAfter(2, 1_800_000);
      await expectRetryAfter(3, 1_800_000);
      firstDeferral(calls, 4).resolve("installed");
      await flushMicrotasks();
    } finally {
      scheduler.dispose();
    }
  });

  it("a newer mapTileCacheVersion resets the backoff", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(5000);
      await failBuild(calls, 0);
      await vi.advanceTimersByTimeAsync(60_000);
      await failBuild(calls, 1);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 2,
        retryAt: Date.now() + 300_000,
        version: 3,
      });

      // An edit bumps the version: the pending retry is cancelled and the
      // normal debounced build runs instead of waiting out 5 m.
      scheduler.schedule("s1", 4);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", undefined);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(3);

      // The count restarted: the next failure waits 1 m, not 30 m.
      await failBuild(calls, 2);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 1,
        retryAt: Date.now() + 60_000,
        version: 4,
      });

      // And the old 5 m retry never fires on top of it.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(startBuild).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(startBuild).toHaveBeenCalledTimes(4);
      firstDeferral(calls, 3).resolve("installed");
      await flushMicrotasks();
    } finally {
      scheduler.dispose();
    }
  });

  it("a newer version queued mid-build skips the backoff when that build fails", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(5000);
      scheduler.schedule("s1", 4);
      await failBuild(calls, 0);
      expect(startBuild).toHaveBeenCalledTimes(2);
      expect(onBackoff).not.toHaveBeenCalled();
      firstDeferral(calls, 1).resolve("installed");
      await flushMicrotasks();
    } finally {
      scheduler.dispose();
    }
  });

  it("ensure() retries now but keeps escalating on a repeat failure", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(5000);
      await failBuild(calls, 0);

      // The manual retry skips the remaining minute.
      scheduler.ensure("s1");
      expect(startBuild).toHaveBeenCalledTimes(2);
      await failBuild(calls, 1);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 2,
        retryAt: Date.now() + 300_000,
        version: 3,
      });

      // The cancelled 1 m retry does not also fire.
      await vi.advanceTimersByTimeAsync(299_999);
      expect(startBuild).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(startBuild).toHaveBeenCalledTimes(3);
      firstDeferral(calls, 2).resolve("installed");
      await flushMicrotasks();
    } finally {
      scheduler.dispose();
    }
  });

  it("restoreBackoff() keeps a reloaded page inside the persisted window", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs });
    try {
      scheduler.restoreBackoff("s1", {
        failures: 2,
        retryAt: Date.now() + 120_000,
        version: 3,
      });
      // The reloaded manager sees the same stale version: no fresh attempt.
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(startBuild).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(startBuild).toHaveBeenCalledTimes(1);

      // The restored count carries on: the next failure waits 30 m.
      const onBackoffAfterRestore = vi.fn<OnBackoff>(),
        restored = new TileArchiveScheduler(startBuild, 5000, {
          backoffMs,
          onBackoff: onBackoffAfterRestore,
        });
      try {
        restored.restoreBackoff("s2", { failures: 2, retryAt: Date.now(), version: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(startBuild).toHaveBeenLastCalledWith("s2");
        await failBuild(calls, 1);
        expect(onBackoffAfterRestore).toHaveBeenLastCalledWith("s2", {
          failures: 3,
          retryAt: Date.now() + 1_800_000,
          version: 1,
        });
      } finally {
        restored.dispose();
      }
      firstDeferral(calls, 0).resolve("installed");
      await flushMicrotasks();
    } finally {
      scheduler.dispose();
    }
  });

  it("a restored backoff still resets on a newer version", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs });
    try {
      scheduler.restoreBackoff("s1", {
        failures: 3,
        retryAt: Date.now() + 1_800_000,
        version: 3,
      });
      scheduler.schedule("s1", 4);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(1);
      firstDeferral(calls, 0).resolve("installed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1_800_000);
      expect(startBuild).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.dispose();
    }
  });

  it("a same-version trigger during the backoff's own retry adds no build", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(5000);
      await failBuild(calls, 0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(startBuild).toHaveBeenCalledTimes(2);

      // A summaries update lands mid-retry at the same version: queued, but
      // a failed retry drops it and backs off instead of rebuilding at once.
      scheduler.schedule("s1", 3);
      await failBuild(calls, 1);
      expect(startBuild).toHaveBeenCalledTimes(2);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 2,
        retryAt: Date.now() + 300_000,
        version: 3,
      });
    } finally {
      scheduler.dispose();
    }
  });

  it("an ensure() failure before any schedule() adopts the first version seen", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.ensure("s1");
      await failBuild(calls, 0);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 1,
        retryAt: Date.now() + 60_000,
        version: 0,
      });

      // The manager's first trigger reports the version that build read:
      // the backoff holds instead of resetting into an extra attempt.
      scheduler.schedule("s1", 5);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(startBuild).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(startBuild).toHaveBeenCalledTimes(2);

      // The retry's failure counts against that version.
      await failBuild(calls, 1);
      expect(onBackoff).toHaveBeenLastCalledWith("s1", {
        failures: 2,
        retryAt: Date.now() + 300_000,
        version: 5,
      });
    } finally {
      scheduler.dispose();
    }
  });

  it("clear() drops the backoff and its armed retry", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    try {
      scheduler.schedule("s1", 3);
      await vi.advanceTimersByTimeAsync(5000);
      await failBuild(calls, 0);

      // Another tab installed the archive: the manager clears the dataset.
      scheduler.clear("s1");
      expect(onBackoff).toHaveBeenLastCalledWith("s1", undefined);
      await vi.advanceTimersByTimeAsync(1_800_000);
      expect(startBuild).toHaveBeenCalledTimes(1);

      // Clearing a dataset with no backoff reports nothing.
      onBackoff.mockClear();
      scheduler.clear("s1");
      scheduler.clear("other");
      expect(onBackoff).not.toHaveBeenCalled();
    } finally {
      scheduler.dispose();
    }
  });

  it("a build settling after dispose() arms no retry and runs no queued build", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      onBackoff = vi.fn<OnBackoff>(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs, onBackoff });
    scheduler.schedule("s1", 3);
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.schedule("s1", 4);
    scheduler.dispose();

    await failBuild(calls, 0);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(startBuild).toHaveBeenCalledTimes(1);
    expect(onBackoff).not.toHaveBeenCalled();
  });

  it("backs off per dataset", async () => {
    const { calls, startBuild } = deferredStartBuild(),
      scheduler = new TileArchiveScheduler(startBuild, 5000, { backoffMs });
    try {
      scheduler.schedule("a", 1);
      await vi.advanceTimersByTimeAsync(5000);
      await failBuild(calls, 0);

      scheduler.schedule("a", 1);
      scheduler.schedule("b", 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(startBuild).toHaveBeenCalledTimes(2);
      expect(startBuild).toHaveBeenLastCalledWith("b");
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
    expect(isTileArchiveStale({ ...geospatial, mapTileArchiveFormatCurrent: false }, 0)).toBe(
      false,
    );
    expect(isTileArchiveStale({ ...geospatial, kind: "standard", mapTileCacheVersion: 1 }, 1)).toBe(
      false,
    );
    expect(isTileArchiveStale({ _id: "s2", kind: "geospatial", mapTileCacheVersion: 1 }, 1)).toBe(
      false,
    );
  });
});

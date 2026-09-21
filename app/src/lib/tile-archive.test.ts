import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TileArchiveScheduler, type TileArchiveBuildOutcome } from "./tile-archive";

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

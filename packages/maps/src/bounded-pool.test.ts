import { describe, expect, it } from "vitest";

import { BoundedPool } from "./bounded-pool";

/** Settles `promise`, or throws a clear HUNG error instead of stalling the
 * suite — a leaked pool slot makes `run()` wait forever. */
async function withWatchdog<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: HUNG`)), 1500);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

async function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BoundedPool", () => {
  it("runs a follow-up task after a wave fully drains", async () => {
    const pool = new BoundedPool(2);
    const wave = Array.from({ length: 4 }, async (_, i) =>
      pool.run(async () => {
        await tick();
        return i;
      }),
    );
    await expect(withWatchdog(Promise.all(wave), "wave")).resolves.toEqual([0, 1, 2, 3]);

    // Regression (issue #134 review): the handoff used to re-increment the
    // active count on every woken waiter while the releaser kept it, so one
    // drained wave left #active at the bound with zero running tasks — every
    // later run() queued forever.
    await expect(
      withWatchdog(
        pool.run(async () => "follow-up"),
        "single follow-up task",
      ),
    ).resolves.toBe("follow-up");
  });

  it("never exceeds the concurrency bound", async () => {
    const pool = new BoundedPool(4);
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 30 }, async () =>
        pool.run(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight -= 1;
        }),
      ),
    );
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // A serial regression would make the bound assert vacuous.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("resumes queued tasks in submission order", async () => {
    const pool = new BoundedPool(1);
    const order: Array<number> = [];
    await Promise.all(
      [0, 1, 2, 3].map(async (i) =>
        pool.run(async () => {
          await tick();
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("propagates a task rejection without wedging the pool", async () => {
    const pool = new BoundedPool(2);
    await expect(
      pool.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      withWatchdog(
        pool.run(async () => "alive"),
        "post-failure task",
      ),
    ).resolves.toBe("alive");
  });
});

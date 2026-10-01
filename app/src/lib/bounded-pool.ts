/**
 * A fixed-size concurrency pool for short-lived async tasks (issue #134).
 * The tile worker runs every geometry payload fetch through one so that at
 * most N fetches are ever in flight — the page loop used to start one fetch
 * per row across every page at once, unbounded in the number of pages.
 *
 * Slots transfer hand-to-hand: a releasing task hands its slot directly to
 * the oldest waiter, so a queued task resumes in submission order. The
 * transfer pre-accounts the slot — the woken waiter does not increment the
 * active count again — so `#active` always equals the number of tasks
 * currently holding a slot and never exceeds the constructor bound.
 */
export class BoundedPool {
  readonly #concurrency: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    this.#concurrency = concurrency;
  }

  /** Runs `task` once a slot is free; the returned promise settles with the
   * task's outcome (rejections propagate to the caller, freeing the slot). */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    // Queue behind existing waiters even if a slot looks momentarily free —
    // while waiters exist the bound is fully subscribed, and this keeps
    // resumption in submission order.
    if (this.#active < this.#concurrency && this.#waiters.length === 0) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
    // Slot transferred by the releasing task: #active already counts this
    // task, so nothing to increment here.
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(); // the slot transfers directly; #active stays at the bound
      return;
    }
    this.#active -= 1;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAnalysis } from "./analysis";
import type { AnalysisRunResult, AnalysisWorkerInbound, AnalysisWorkerOutbound } from "./analysis";

/**
 * The run manager's lifecycle policy (#133 item 2): the timeout and the
 * abort signal must TERMINATE the worker (a runaway WASM query only stops
 * by killing the worker that runs it), fail every queued run with a message
 * that says the worker was restarted, and leave the module respawn-ready.
 * The real worker cannot run under vitest, so a FakeWorker stands in — the
 * manager only ever touches postMessage/addEventListener/terminate.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly messages: AnalysisWorkerInbound[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  terminated = false;

  constructor(_url: URL, _options: { type: string }) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  postMessage(message: unknown): void {
    this.messages.push(message as AnalysisWorkerInbound);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }

  /** Test helper: deliver a worker → main message (the protocol's transport boundary). */
  receive(message: AnalysisWorkerOutbound): void {
    for (const handler of this.listeners.get("message") ?? []) {
      handler({ data: message });
    }
  }
}

const currentWorker = (): FakeWorker => {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  if (worker === undefined) {
    throw new Error("no worker was spawned");
  }
  return worker;
};

const firstPostedRequestId = (): number => {
  const posted = currentWorker().messages[0];
  return posted === undefined ? 0 : posted.requestId;
};

/** The run settled into its error message (or "no rejection") — assertions stay directly-awaited. */
async function messageOf(run: Promise<AnalysisRunResult>): Promise<string> {
  try {
    await run;
    return "no rejection";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

vi.stubGlobal("Worker", FakeWorker);

const REQUEST = {
  source: { as: "source", schemaId: "schema-1" },
  sql: "SELECT 1",
  tables: [],
};

function doneFor(requestId: number): AnalysisWorkerOutbound {
  return {
    requestId,
    result: {
      diagnostics: {
        coercedNulls: 0,
        tables: ["source"],
        totalSourceRows: 0,
        resultRows: 1,
        truncated: false,
      },
      rows: [{ n: 1 }],
    },
    type: "done",
  };
}

afterEach(() => {
  // Each terminated run clears the module's worker; a clean run leaves a
  // live one behind — either way the next test spawns its own.
  vi.restoreAllMocks();
});

describe("runAnalysis — timeout and abort with worker respawn (#133 item 2)", () => {
  it("times a runaway run out, terminates the worker, and respawns a FRESH one for the next run", async () => {
    vi.useFakeTimers();
    const [message] = await Promise.all([
      messageOf(runAnalysis({ ...REQUEST, timeoutMs: 5_000 })),
      vi.advanceTimersByTimeAsync(5_001),
    ]);
    expect(message).toMatch(/timed out after 5s/);
    expect(currentWorker().terminated).toBe(true);

    // The respawn: the next run must not reuse the terminated worker.
    const second = runAnalysis({ ...REQUEST, timeoutMs: 5_000 });
    expect(FakeWorker.instances).toHaveLength(2);
    currentWorker().receive(doneFor(firstPostedRequestId()));
    const settled = await second;
    expect(settled.rows).toStrictEqual([{ n: 1 }]);
    vi.useRealTimers();
  });

  it("fails runs queued behind the timed-out one with the restart message", async () => {
    vi.useFakeTimers();
    const [firstMessage, secondMessage] = await Promise.all([
      messageOf(runAnalysis({ ...REQUEST, timeoutMs: 5_000 })),
      messageOf(runAnalysis({ ...REQUEST, timeoutMs: 60_000 })),
      vi.advanceTimersByTimeAsync(5_001),
    ]);
    expect(firstMessage).toMatch(/timed out after 5s/);
    expect(secondMessage).toMatch(/SQL worker was restarted/);
    expect(currentWorker().terminated).toBe(true);
    vi.useRealTimers();
  });

  it("aborts on the caller's signal and terminates the worker", async () => {
    const controller = new AbortController(),
      pending = messageOf(
        runAnalysis({ ...REQUEST, signal: controller.signal, timeoutMs: 60_000 }),
      );
    controller.abort();
    const message = await pending;
    expect(message).toMatch(/canceled/);
    expect(currentWorker().terminated).toBe(true);
  });

  it("clears the timer when the run settles — a finished run is never killed late", async () => {
    const run = runAnalysis({ ...REQUEST, timeoutMs: 30 });
    currentWorker().receive(doneFor(firstPostedRequestId()));
    const settled = await run;
    expect(settled.rows).toStrictEqual([{ n: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The worker survives: the run ended before the cap, so nothing restarts.
    expect(currentWorker().terminated).toBe(false);
  });
});

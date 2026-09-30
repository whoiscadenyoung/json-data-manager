/**
 * The analysis layer's main-thread half (roadmap stage 9, #105): the typed
 * message protocol with {@link ./analysis.worker.ts} and the run manager —
 * one lazy module worker, one run at a time (the CPU-bound SQL engine
 * serializes on the worker's single thread), pending runs failed on worker
 * crash with a lazy respawn. The tile-archive rebuild manager is the
 * pattern this copies (./tile-archive.ts).
 *
 * The RESOLUTION half does not live here: what dataset each table target
 * reads (pin/float per stage-6 semantics) resolves SERVER-side first,
 * through `consumption.analysisTargets` (the same `resolveSourceHead` core
 * the 7b layer resolutions ride), and the caller hands this manager the
 * RESOLVED component ids. The worker never resolves and never fetches rows
 * itself — it registers tables from the row-resolution seam and runs the
 * query (the doc's "one seam" invariant; a per-surface row path is the
 * recorded smell).
 *
 * Parquet sidecar note (doc §3:59-63): conditional, NOT built in v1. This
 * registration path is shaped so a sidecar can substitute for streaming —
 * a future DuckDB HTTP-range read over a per-version Parquet artifact
 * replaces `fetchDatasetEntryRows` inside the worker, and nothing on this
 * side of the protocol changes.
 */
import { fetchConvexToken } from "#/lib/convex-auth-token";

/** One resolved table target: the SQL name its rows register under + the component row the seam should page. */
export interface AnalysisTableTarget {
  /** The SQL name (the spec's `as`). */
  as: string;
  /** The RESOLVED component dataset id (post stage-6 resolution — identity or float head). */
  schemaId: string;
}

/** One analysis run request: the query, the source table, the side tables, the result cap. */
export interface AnalysisRequest {
  /** Hard cap on returned rows (truncation is reported in diagnostics, never silent). */
  limit?: number;
  /** Progress callback for the worker's transient phases (the first run downloads the WASM engine — worth surfacing). */
  onPhase?: (phase: AnalysisRunPhase) => void;
  source: AnalysisTableTarget;
  sql: string;
  tables: AnalysisTableTarget[];
}

/** What one run returns: plain-record rows plus the engine's diagnostics (error carried here, never thrown). */
export interface AnalysisRunResult {
  diagnostics: import("@caden/json-cms/transform").SqlDiagnostics;
  rows: Array<Record<string, unknown>>;
}

/** Transient phases the worker posts while a run executes. */
export type AnalysisRunPhase = "loading-engine" | "loading-rows" | "running";

/** Main thread → worker: token replies, then one analyze request per run. */
export type AnalysisWorkerInbound =
  | { requestId: number; token: string | null; type: "token" }
  | ({ requestId: number } & AnalysisRequest & { type: "analyze" });

/** Worker → main thread: token requests, phases, then one terminal message. */
export type AnalysisWorkerOutbound =
  | { requestId: number; type: "token-request" }
  | { phase: AnalysisRunPhase; requestId: number; type: "phase" }
  | ({ requestId: number; result: AnalysisRunResult } & { type: "done" })
  | { message: string; requestId: number; type: "error" };

// --- Worker lifecycle + message protocol (the tile-archive shape) ---

let analysisWorker: Worker | undefined;
let requestSeq = 0;
const pendingRuns = new Map<
  number,
  {
    onPhase?: (phase: AnalysisRunPhase) => void;
    reject: (error: Error) => void;
    resolve: (result: AnalysisRunResult) => void;
  }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Answers the worker's Convex-token requests — its standalone client authenticates through here (the worker has no Better Auth session). */
async function replyToken(requestId: number): Promise<void> {
  const worker = analysisWorker;
  if (worker === undefined) return;
  const token = await fetchConvexToken();
  // `Worker.postMessage` takes (message, transfer) — there is no
  // `targetOrigin` parameter to pass at the worker boundary.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage({ requestId, token, type: "token" } satisfies AnalysisWorkerInbound);
}

function handleWorkerTokenRequest(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (!isRecord(data) || typeof data.requestId !== "number" || data.type !== "token-request") {
    return;
  }
  void replyToken(data.requestId);
}

/** Runtime shape check for a done message's payload — the one narrowing the protocol's `unknown` transport needs (structured clone delivers exactly what the worker posts; the guard keeps the assumption in one audited place). */
function isRunResult(value: unknown): value is AnalysisRunResult {
  return isRecord(value) && isRecord(value.diagnostics) && Array.isArray(value.rows);
}

function settlePending(requestId: number, data: Record<string, unknown>): boolean {
  const pending = pendingRuns.get(requestId);
  if (pending === undefined) {
    return false;
  }
  pendingRuns.delete(requestId);
  if (data.type === "done") {
    if (isRunResult(data.result)) {
      pending.resolve(data.result);
      return true;
    }
    pending.reject(new Error("The analysis worker returned a malformed result."));
  } else {
    pending.reject(
      new Error(typeof data.message === "string" ? data.message : "The analysis run failed."),
    );
  }
  return true;
}

function isRunPhase(value: unknown): value is AnalysisRunPhase {
  return value === "loading-engine" || value === "loading-rows" || value === "running";
}

function handleWorkerMessage(event: MessageEvent<unknown>): void {
  const data: unknown = event.data;
  if (!isRecord(data) || typeof data.requestId !== "number") return;
  if (data.type === "phase") {
    // Forward the transient phase to the run's callback (the first run's
    // WASM download should never be indistinguishable from a slow query).
    const pending = pendingRuns.get(data.requestId);
    if (pending !== undefined && pending.onPhase !== undefined && isRunPhase(data.phase)) {
      pending.onPhase(data.phase);
    }
    return;
  }
  if (data.type === "done" || data.type === "error") {
    settlePending(data.requestId, data);
  }
}

function getWorker(): Worker {
  if (analysisWorker === undefined) {
    const spawned = new Worker(new URL("./analysis.worker.ts", import.meta.url), {
      type: "module",
    });
    spawned.addEventListener("message", handleWorkerTokenRequest);
    spawned.addEventListener("message", handleWorkerMessage);
    spawned.addEventListener("error", () => {
      // The worker itself died (not just one run): fail everything pending
      // so callers unwedge, and respawn lazily on the next run.
      for (const [requestId, pending] of pendingRuns) {
        pendingRuns.delete(requestId);
        pending.reject(new Error("The analysis worker crashed — try the run again."));
      }
      analysisWorker = undefined;
      spawned.terminate();
    });
    analysisWorker = spawned;
  }
  return analysisWorker;
}

/**
 * Runs one analysis: spawns (or reuses) the worker, sends the request,
 * resolves with the query's rows + diagnostics. Rejects only on transport
 * failure (worker crash, message loss) — a bad query resolves with
 * `diagnostics.error` set, because a user-authored SQL text failing is a
 * result, not an exception.
 */
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisRunResult> {
  requestSeq += 1;
  const requestId = requestSeq;
  return await new Promise<AnalysisRunResult>((resolve, reject) => {
    pendingRuns.set(requestId, { onPhase: request.onPhase, reject, resolve });
    // `Worker.postMessage` takes (message, transfer) — there is no
    // `targetOrigin` parameter to pass at the worker boundary.
    // oxlint-disable unicorn/require-post-message-target-origin -- see above; the rule anchors inside the multi-line call.
    getWorker().postMessage({
      limit: request.limit,
      requestId,
      source: request.source,
      sql: request.sql,
      tables: request.tables,
      type: "analyze",
    } satisfies AnalysisWorkerInbound);
    // oxlint-enable unicorn/require-post-message-target-origin
  });
}

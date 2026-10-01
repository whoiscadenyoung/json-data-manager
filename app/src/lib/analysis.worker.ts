/**
 * The analysis worker (roadmap stage 9, #105; docs/analysis-layer-design.md
 * §2) — one "analyze" message per run: page every table target's rows to
 * exhaustion through the row-resolution SEAM (never its own row path), type
 * the columns from each dataset's declared structure, register them into
 * DuckDB-WASM, and run the query via `applySql` (the pure engine — the same
 * interface rollup runs through, which is what makes a saved analysis
 * publishable with zero new concepts).
 *
 * Invariants this module is the concrete proof of:
 * - **Client-side only.** The SQL engine is WASM in THIS worker; there is
 *   no server-side analytics anywhere (app/convex imports no analysis code).
 * - **One seam.** The only row source is `fetchDatasetEntryRows` (drafts
 *   with specs applied, published rows, version rows — whatever the seam
 *   resolves); `api.schemas.get` is a METADATA read for the declared
 *   structure (the tile-archive worker's precedent), never a row path.
 * - **The auth choke point is inherited, not re-implemented.** The worker's
 *   standalone ConvexClient authenticates through the main thread (its setAuth
 *   fetcher round-trips a token request over the message channel — the worker
 *   has no Better Auth session). The fetcher attaches ONCE
 *   (`setAuthReasserting`, #133 item 6) and re-arms itself only after a null
 *   token, so a client created signed-out still authenticates once a session
 *   exists — and no run pauses the socket re-asserting auth. Every seam call
 *   rides `entries.listPage` behind the app's auth wrapper, which rejects the
 *   unauthenticated and denies invisible datasets — a foreign draft's rows
 *   are unreachable from here by construction.
 * - One run at a time: the CPU-bound WASM query serializes on the
 *   promise-chained queue (the tile-archive pattern).
 */
import { applySql, declaredColumnTypes } from "@caden/json-cms/transform";
import type { SqlColumnSpec, SqlOperation, SqlSideTable } from "@caden/json-cms/transform";
import { ConvexClient } from "convex/browser";

import { env } from "#/env";
import { setAuthReasserting } from "#/lib/convex-auth-token";
import { api } from "#convex/_generated/api";

import type { AnalysisWorkerInbound, AnalysisWorkerOutbound } from "./analysis";
import {
  MAX_ANALYSIS_RESULT_ROWS,
  MAX_ANALYSIS_SOURCE_ROWS,
  sourceRowCapError,
} from "./analysis-caps";
import { analysisSqlEngine } from "./analysis-duckdb";
import { entryDataRecord, forEachDatasetEntryPage } from "./dataset-rows";

/** Worker scope (`DedicatedWorkerGlobalScope`) isn't available to name under the app's DOM-lib tsconfig, but `self.postMessage` / `self.addEventListener` used here are the same calls on the narrow worker surface this module uses — at runtime `self` IS the worker scope. */
function post(message: AnalysisWorkerOutbound): void {
  // Worker-scope `postMessage` takes (message, transfer) — the `targetOrigin`
  // second argument this lint rule wants does not exist in worker scope.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(message);
}

let client: ConvexClient | undefined;

/**
 * The standalone client authenticates through the main thread: its setAuth
 * fetcher round-trips a token request over the message channel. The main
 * thread replies with null when signed out; the client then runs
 * unauthenticated and the seam's first page fails with the sign-in gate's
 * error — reported as the run's error message, never a crash.
 *
 * The fetcher attaches ONCE (`setAuthReasserting`, #133 item 6) and
 * re-arms itself only after a null token — a client first created signed
 * out authenticates as soon as a session exists (sign-out reloads the
 * page, but sign-in does not). The old per-message `setAuth` re-assert
 * paused the socket on every run.
 */
let tokenRequestSeq = 0;
const pendingTokenRequests = new Map<number, (token: string | null) => void>();

async function fetchTokenFromMain(): Promise<string | null> {
  return new Promise((resolve) => {
    tokenRequestSeq += 1;
    pendingTokenRequests.set(tokenRequestSeq, resolve);
    post({ requestId: tokenRequestSeq, type: "token-request" });
  });
}

function convexClient(): ConvexClient {
  if (client === undefined) {
    const created = new ConvexClient(env.VITE_CONVEX_URL);
    setAuthReasserting(created, fetchTokenFromMain);
    client = created;
  }
  return client;
}

// One heavy run at a time: async row paging may interleave, but the CPU-bound
// WASM SQL serializes on this worker's single thread.
let runQueue: Promise<void> = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<AnalysisWorkerInbound>) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "token") {
    const resolve = pendingTokenRequests.get(message.requestId);
    if (resolve !== undefined) {
      pendingTokenRequests.delete(message.requestId);
      resolve(message.token);
    }
    return;
  }
  if (message.type !== "analyze") return;
  const { requestId } = message;
  runQueue = runQueue.then(async () => runAnalysis(requestId, message)).catch(() => undefined); // runAnalysis reports its own error message; the queue keeps draining.
});

/** One table target's declared columns + seam-materialized engine records. */
interface LoadedTable {
  columns: SqlColumnSpec[];
  rows: Array<Record<string, unknown>>;
  title?: string;
}

/**
 * Streams one dataset's seam pages into the engine records, capping the
 * source rows (#133 item 7): each page's rows adapt once —
 * `entryDataRecord` per row — and the raw `DatasetEntryRow`s are dropped as
 * the next page loads, instead of the whole entry set and its record copy
 * being held at once. Past `MAX_ANALYSIS_SOURCE_ROWS` the run fails with
 * the cap's message; a larger analysis belongs behind a rollup.
 */
async function loadTable(schemaId: string): Promise<LoadedTable> {
  const convex = convexClient();
  // Metadata read for the declared structure (NOT a row path): the typed
  // end-to-end invariant registers columns from the DECLARED structure and
  // lets materializeSqlTable infer only what the rows carry beyond it.
  const schema = await convex.query(api.schemas.get, { schemaId });
  if (schema === null) {
    // The auth choke point's indistinguishable denial (a foreign draft, an
    // author-visibility row) and a deleted dataset read the same here.
    throw new Error("A dataset in this analysis doesn't exist or you don't have access to it.");
  }
  const rows: Array<Record<string, unknown>> = [];
  await forEachDatasetEntryPage(
    schemaId,
    (page) => {
      if (rows.length + page.length > MAX_ANALYSIS_SOURCE_ROWS) {
        throw new Error(sourceRowCapError(schema.title));
      }
      for (const row of page) {
        rows.push(entryDataRecord(row));
      }
    },
    { convex },
  );
  return {
    columns: declaredColumnTypes(schema.schema),
    rows,
    title: schema.title,
  };
}

async function runAnalysis(
  requestId: number,
  request: Extract<AnalysisWorkerInbound, { type: "analyze" }>,
): Promise<void> {
  try {
    post({ phase: "loading-engine", requestId, type: "phase" });
    const engine = await analysisSqlEngine();
    post({ phase: "loading-rows", requestId, type: "phase" });
    const source = await loadTable(request.source.schemaId),
      sides = new Map<string, SqlSideTable>();
    for (const target of request.tables) {
      // oxlint-disable-next-line no-await-in-loop -- each table pages a dataset to exhaustion; sequential keeps memory bounded (the loadPublishTables precedent).
      const loaded = await loadTable(target.schemaId);
      sides.set(target.as, { columns: loaded.columns, rows: loaded.rows });
    }
    post({ phase: "running", requestId, type: "phase" });
    // The stored spec's operation shape, reconstructed from the request —
    // the same plain data a registry row stores, so an interactive run and
    // a publish execution exercise ONE engine path.
    const operation: SqlOperation = {
      kind: "sql",
      sourceAs: request.source.as,
      sql: request.sql,
      tables: request.tables.map((target) => ({ as: target.as, datasetId: target.schemaId })),
    };
    const result = await applySql(operation, source.rows, sides, engine, {
      limit: request.limit ?? MAX_ANALYSIS_RESULT_ROWS,
      sourceColumns: source.columns,
    });
    post({ requestId, result, type: "done" });
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      requestId,
      type: "error",
    });
  }
}

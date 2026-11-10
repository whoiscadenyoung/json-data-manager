/**
 * The row-path geometry worker ([remedies 1] / #287) — the
 * `PgGeometriesLoader` fan-out's paging + resolution half, moved off the
 * main thread. One dataset per inbound "load": page `dataset_rows_for_tiles`
 * to exhaustion (cursor-chained, the §5.5 completeness rule), resolve each
 * row's GeoJSON (inline jsonb parses here as part of the RPC response's
 * own `res.json()`; storage-backed rows sign a URL and fetch through a
 * bounded pool), and post PARSED geometry back per page. The main thread
 * never stringifies or re-parses a coordinate payload — the structured
 * clone across `postMessage` is the only remaining copy ([remedies 1]'s
 * decision, recorded in ADR 0025; the superseded path paid a main-thread
 * `res.json()` for the whole page, a per-row `JSON.stringify` into
 * `geometryJson`, and a per-row re-parse in `useResolvedGeometries`).
 *
 * Runs inside a web worker on its OWN supabase client (the tile-archive
 * worker's pattern: fresh token per run, `persistSession: false` — a worker
 * scope has no localStorage and the cookie-bound browser client is a
 * main-thread object). Pages ride the tile feed's default width: the parse
 * lives HERE, so wide pages cost nothing on the main thread, and each
 * dataset lands on the map as one update (per-page map rebuilds would be
 * an O(pages²) main-thread cost — ADR 0025). Take sizing stays where
 * response size matters: the archive build's fetch phase
 * (`geometryTakeRowsFor`).
 *
 * A fresh "load" for a dataset with a run in flight cancels the old run
 * between pages (queries invalidate on entry edits — the new run's pages
 * are the truth; the old run's are stale) and starts over.
 */
import { BoundedPool } from "@caden/maps/bounded-pool";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "#/env";
import {
  DEFAULT_GEOMETRY_PAGE_ROWS,
  geometryRowsPageSized,
  resolveGeometryRowForRender,
} from "#/lib/pg-geometry-fetch";
import type { DatasetGeometryType } from "#/lib/store/datasets";

/** One resolved row as it crosses to the main thread: parsed GeoJSON, nothing stringified. `geometry` is absent when its payload failed to resolve (the row renders nowhere — the same posture as the old per-row catch in `resolveGeometryRows`). */
export interface PgGeometryWorkerRow {
  entryId: string;
  geometry?: unknown;
  type: DatasetGeometryType;
}

export type PgGeometryRowsWorkerOutbound =
  | { requestId: number; source: "supabase"; type: "token-request" }
  | {
      datasetId: string;
      /** null = exhausted (the §5 intro completeness rule the loader latches `complete` on). */
      nextCursor: string | null;
      /** The run token the loader posted with the "load" — the loader drops events from superseded runs. */
      runId: number;
      rows: PgGeometryWorkerRow[];
      type: "page";
    }
  | { datasetId: string; message: string; runId: number; type: "load-error" };

export type PgGeometryRowsWorkerInbound =
  | { requestId: number; token: string | null; type: "token" }
  | { datasetId: string; runId: number; type: "load" }
  | { datasetId: string; type: "cancel" };

// Worker scope (`DedicatedWorkerGlobalScope`) isn't available to name under
// the app's DOM-lib tsconfig, but `self.postMessage` / `self.addEventListener`
// used here are the same calls on the narrow worker surface this module uses —
// at runtime `self` IS the worker scope.
function post(message: PgGeometryRowsWorkerOutbound): void {
  // Worker-scope `postMessage` takes (message, transfer) — the `targetOrigin`
  // second argument this lint rule wants does not exist in worker scope.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(message);
}

// --- Token bridge (the tile-archive worker's protocol, verbatim) ---

let tokenRequestSeq = 0;
const pendingTokenRequests = new globalThis.Map<number, (token: string | null) => void>();

async function fetchTokenFromMain(): Promise<string | null> {
  return await new Promise((resolve) => {
    tokenRequestSeq += 1;
    pendingTokenRequests.set(tokenRequestSeq, resolve);
    post({ requestId: tokenRequestSeq, source: "supabase", type: "token-request" });
  });
}

/** The worker's own supabase client — fresh per load run (the tile worker's rationale: no long-lived bearer, no socket, no session persistence). */
async function pgSupabaseClient(): Promise<SupabaseClient> {
  const token = await fetchTokenFromMain();
  if (token === null) {
    throw new Error("Sign in to load Postgres dataset rows.");
  }
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// --- Load runs (one in flight per dataset; a re-load cancels the old) ---

const activeRuns = new globalThis.Map<string, AbortController>();

// Payload fetches in flight at once (the tile worker's #134 pool size —
// twelve overlaps page round trips without thrashing the browser's
// per-origin connection pool). One pool per run: a cancelled run's pool
// drains with it.
const GEOMETRY_PAYLOAD_POOL_SIZE = 12;
const pools = new globalThis.Map<string, BoundedPool>();

async function runLoad(datasetId: string, runId: number): Promise<void> {
  const previous = activeRuns.get(datasetId);
  if (previous !== undefined) {
    previous.abort();
  }
  const controller = new AbortController(),
    pool = new BoundedPool(GEOMETRY_PAYLOAD_POOL_SIZE);
  activeRuns.set(datasetId, controller);
  pools.set(datasetId, pool);
  try {
    const supabase = await pgSupabaseClient();
    // The tile feed's default width (§5.5) — deliberately NOT take-sized:
    // parsing lives here in the worker, so a wide page costs nothing but
    // network, and each dataset lands as ONE maplibre setData (the map's
    // per-page rebuilds are the O(pages²) main-thread cost ADR 0025
    // defers — progressive fill happens per DATASET, not per page).
    await streamPages(datasetId, runId, supabase, controller, pool, DEFAULT_GEOMETRY_PAGE_ROWS);
  } catch (error) {
    if (!controller.signal.aborted) {
      post({
        datasetId,
        message: error instanceof Error ? error.message : String(error),
        runId,
        type: "load-error",
      });
    }
  } finally {
    if (activeRuns.get(datasetId) === controller) {
      activeRuns.delete(datasetId);
      pools.delete(datasetId);
    }
  }
}

/**
 * One run's cursor-chained pass over the tile feed (the §5.5 completeness
 * loop): page, resolve through the pool, post, continue — until exhaustion
 * or the run's abort. Each page resolves BEFORE the next is fetched, so the
 * pool's backlog stays one page deep (the tile worker's shape).
 */
// The keyset cursor chains page to page (each await feeds the next); the
// pg-app-publish walk carries the same scoped suspension.
/* oxlint-disable eslint/no-await-in-loop -- the paging is inherently sequential. */
async function streamPages(
  datasetId: string,
  runId: number,
  supabase: SupabaseClient,
  controller: AbortController,
  pool: BoundedPool,
  pageRows: number,
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    if (controller.signal.aborted) return;
    const page = await geometryRowsPageSized(supabase, datasetId, cursor, pageRows);
    const resolved = await resolveRows(supabase, pool, controller, page.rows);
    if (controller.signal.aborted) return;
    post({ datasetId, nextCursor: page.nextCursor, rows: resolved, runId, type: "page" });
    if (page.nextCursor === null) return;
    cursor = page.nextCursor;
  }
}
/* oxlint-enable eslint/no-await-in-loop */

/** Resolves one page's rows through the bounded pool — parsed geometry or absent (per-row failures never fail the page; the old seam's posture). */
async function resolveRows(
  supabase: SupabaseClient,
  pool: BoundedPool,
  controller: AbortController,
  rows: Array<{
    entryId: string;
    geometry: unknown;
    sourcePath: string | null;
    type: DatasetGeometryType;
  }>,
): Promise<PgGeometryWorkerRow[]> {
  const tasks = rows.map(async (row) =>
    pool.run(async () => {
      if (controller.signal.aborted) return null;
      try {
        return {
          entryId: row.entryId,
          geometry: await resolveGeometryRowForRender(supabase, row),
          type: row.type,
        };
      } catch {
        // Unreadable payload: the row renders nowhere (the per-row catch
        // posture), everything else keeps streaming.
        return { entryId: row.entryId, type: row.type };
      }
    }),
  );
  const settled = await Promise.all(tasks);
  return settled.filter((row): row is PgGeometryWorkerRow => row !== null);
}

// Worker scope: `self.addEventListener` — see the `post` note above.
self.addEventListener("message", (event: MessageEvent<PgGeometryRowsWorkerInbound>) => {
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
  if (message.type === "cancel") {
    const run = activeRuns.get(message.datasetId);
    if (run !== undefined) {
      run.abort();
    }
    return;
  }
  void runLoad(message.datasetId, message.runId).catch(() => undefined);
});

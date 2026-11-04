import { MAX_ANALYSIS_SOURCE_ROWS, sourceRowCapError } from "@caden/analysis/caps";
import type { SqlColumnSpec } from "@caden/data-core/transform";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "#/env";
import { entryDataRecord, forEachDatasetEntryPage } from "#/lib/dataset-rows-pg";

import type { AnalysisTableTarget } from "./analysis";

/**
 * The analysis worker's Postgres half (stage 5, #204; design §8.3) — the
 * Convex `loadTable` counterpart: rows page to exhaustion through the
 * row-resolution SEAM (`forEachDatasetEntryPage`, run on a worker-owned
 * plain `createClient` — the cookie-bound browser client is a main-thread
 * object, the tile-archive worker's precedent) while the declared structure
 * and title ride the run request, resolved MAIN-THREAD from the store's
 * dataset row. No metadata fetch exists on this path: the worker's only
 * network reads are the seam's row pages.
 *
 * The DuckDB engine itself is backend-agnostic — `analysisSqlEngine()`
 * (packages/analysis duckdb.ts) instantiates identically in both paths, its
 * blob-worker `?url` absolutization intact — and the lockdown (#132)
 * applies before any caller query on either.
 */

/** One table target's declared columns + seam-materialized engine records. */
export interface LoadedTable {
  columns: SqlColumnSpec[];
  rows: Array<Record<string, unknown>>;
  title?: string;
}

/**
 * The worker's own supabase client, built per PG run from a FRESH access
 * token (a long-lived client would carry an expired bearer past the token's
 * hour — the tile worker's recorded rationale; a fresh client costs nothing,
 * there is no socket to re-establish). `persistSession: false` keeps GoTrue
 * away from localStorage, which a worker scope does not have; the identity
 * rides every request as the Authorization header, so RLS scopes the seam's
 * row pages exactly as the signed-in user. A null token (signed out) fails
 * LOUDLY — an unauthenticated client would silently see zero rows and run
 * the query over an empty `source` table.
 *
 * `fetchToken` is injected (the worker's message-channel round trip) so the
 * client policy is testable without a worker scope.
 */
export async function pgWorkerSupabaseClient(
  fetchToken: () => Promise<string | null>,
): Promise<SupabaseClient> {
  const token = await fetchToken();
  if (token === null) {
    throw new Error("Sign in to analyze Postgres datasets.");
  }
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * Streams one PG dataset's seam pages into the engine records, capping the
 * source rows (#133 item 7, the Convex path's rule): each page's rows adapt
 * once — `entryDataRecord` per row — and the raw `DatasetEntryRow`s drop as
 * the next page loads. Past `MAX_ANALYSIS_SOURCE_ROWS` the run fails with
 * the cap's message naming the dataset (the title arrives on the request —
 * resolved main-thread); a larger analysis belongs behind a rollup.
 *
 * The declared columns come from the request too; an absent list (a caller
 * that skipped the store read) degrades to engine inference over the rows —
 * materializeSqlTable infers from the cells — rather than a hard failure,
 * exactly the tolerance the typed-end-to-end invariant tolerates for
 * structure-less sources.
 */
export async function loadPgTable(
  target: AnalysisTableTarget,
  supabase: SupabaseClient,
): Promise<LoadedTable> {
  const rows: Array<Record<string, unknown>> = [];
  await forEachDatasetEntryPage(
    target.schemaId,
    (page) => {
      if (rows.length + page.length > MAX_ANALYSIS_SOURCE_ROWS) {
        throw new Error(sourceRowCapError(target.title ?? "the dataset"));
      }
      for (const row of page) {
        rows.push(entryDataRecord(row));
      }
    },
    { supabase },
  );
  return {
    columns: target.columns ?? [],
    rows,
    title: target.title,
  };
}

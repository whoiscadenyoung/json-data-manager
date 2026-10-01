/**
 * The analysis layer's build-time caps (roadmap stage 9, #105; the issue's
 * "memory_limit/result caps set" deferral). The memory limit lives with the
 * engine (analysis-duckdb.ts, set at instantiation); the RESULT cap lives
 * here because three callers share it and must not drift: the analysis
 * worker's interactive runs, the publish path's materialization, and the
 * preview's default. Truncation is always REPORTED in diagnostics
 * (`truncated` + pre-cap `resultRows`), never silent — a cut result set
 * must never masquerade as complete.
 */

/** Maximum rows one analysis run returns. A query meaning more must say LIMIT itself; the cap exists so a careless `SELECT *` cannot freeze the tab or wedge a publish. */
export const MAX_ANALYSIS_RESULT_ROWS = 10_000;

/**
 * Maximum SOURCE rows one analysis run loads, across the source table and
 * every side table (#133 item 7). Row entry is schemaless JSON materialized
 * three times over (seam record → materialized table → Arrow), so the cap
 * is what keeps a whole-dataset analysis from exhausting the tab — a larger
 * job belongs behind a rollup (Transform tab) whose output is analyzed.
 * Exceeding it fails the run with a message that says exactly this.
 */
export const MAX_ANALYSIS_SOURCE_ROWS = 100_000;

/** The clear over-cap message (#133 item 7): names the dataset, the cap, and the way out. */
export function sourceRowCapError(title: string): string {
  return `"${title}" has more than ${MAX_ANALYSIS_SOURCE_ROWS.toLocaleString()} rows — analyses load at most ${MAX_ANALYSIS_SOURCE_ROWS.toLocaleString()} source rows. Build a rollup of it in the Transform tab (or trim the dataset) and analyze that instead.`;
}

/**
 * Wall-clock cap on one analysis run (#133 item 2): a runaway query
 * (`range(1e12)`, a cross join) would otherwise pin the single-threaded WASM
 * worker forever, queueing every later run behind it. Expiry TERMINATES and
 * respawns the worker, failing the run with a clear message. Generous by
 * design — the first run also downloads the WASM engine — and overridable
 * per call via `AnalysisRequest.timeoutMs`.
 */
export const ANALYSIS_RUN_TIMEOUT_MS = 180_000;

/** Rows the preview table renders from a run's (already-capped) result — a display bound, not a data bound. */
export const ANALYSIS_PREVIEW_ROWS = 100;

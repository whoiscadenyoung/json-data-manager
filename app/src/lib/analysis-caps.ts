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

/** Rows the preview table renders from a run's (already-capped) result — a display bound, not a data bound. */
export const ANALYSIS_PREVIEW_ROWS = 100;

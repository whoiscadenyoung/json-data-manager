/**
 * The serializable SQL operation the Analysis tab's DuckDB engine runs
 * (docs/analysis-layer-design.md). The derived-dataset operations
 * (lookup / rollup / geometrySource) and the `TransformSpec` envelope were
 * retired with the derived registry (#301); views (`@caden/data-core/views`)
 * replace them, and the Analysis tab itself retires in #306.
 */

/**
 * One table a `SqlOperation`'s query reads beyond its source: the dataset id
 * plus the SQL name its rows register under — the pair both the dependency
 * walk (below) and every executor need. The name is author-chosen free text
 * (a quoted identifier if it must); the engine registers exactly what the
 * spec names, so a saved query round-trips byte-stable.
 */
export interface SqlTableRef {
  /** Dataset the table's rows come from — a component dataset id, stored as a plain string (the #95 registry precedent). */
  datasetId: string;
  /** The SQL name the dataset's rows register under (e.g. "grants"). */
  as: string;
}

/**
 * Freeform SQL over registered tables (docs/analysis-layer-design.md, roadmap
 * stage 9, #105): the power-user escape hatch beside the rollup primitive —
 * ONE system, not two. The spec is plain serializable data (`sql` text plus
 * named table refs); the query runs client-side in a DuckDB-WASM engine
 * (analysis-layer-design.md §2's client-side-only invariant) through the same
 * engine interface as every other kind — `applySql` (sql.ts) — which takes
 * the engine handle as its fourth argument (a WASM in-memory database does
 * I/O-free compute; the function itself imports nothing beyond coercion.js
 * and this module, like its siblings).
 */
export interface SqlOperation {
  kind: "sql";
  /** The read-only SQL query text (a SELECT over the registered tables). */
  sql: string;
  /**
   * The SQL name the spec's source rows register under. Omitted → "source"
   * (the recorded default, sql.ts). The source is ALWAYS registered — a
   * query over no table has nothing to analyze.
   */
  sourceAs?: string;
  /**
   * Side tables the query joins, in spec order. These are the operation's
   * dependency edges (see `transformSpecDependencies`): a query naming a
   * dataset must contribute the edge or the registry's cycle walk, health
   * walk, visibility gate, and bundle press order all go blind on it.
   */
  tables: SqlTableRef[];
}

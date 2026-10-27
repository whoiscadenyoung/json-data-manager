/**
 * `@caden/data-core/transform` — the React-free transform surface (roadmap
 * stage 3b, issue #97): the pure engine and its spec types, importable
 * without any React, convex/react, or query-bridge code (the row-resolution
 * seam is shared with the tile-archive web worker). `@caden/json-cms/react`
 * re-exports the same names from here, so the two cannot drift.
 */
export { applyLookup, LookupKeyConflictError } from "./lookup.js";
export { applyRollup } from "./rollup.js";
export { applySql, declaredColumnTypes, materializeSqlTable, sqlSourceName } from "./sql.js";
export { transformSpecDependencies, geometrySourceOperationOf } from "./spec.js";
export type { LookupDiagnostics, LookupResult } from "./lookup.js";
export type { RollupDiagnostics, RollupResult } from "./rollup.js";
export type {
  SqlApplyOptions,
  SqlColumnSpec,
  SqlDiagnostics,
  SqlEngine,
  SqlResult,
  SqlColumnType,
  SqlSideTable,
  SqlTable,
} from "./sql.js";
export type {
  GeometrySource,
  LookupOperation,
  RollupMeasure,
  RollupOperation,
  SqlOperation,
  SqlTableRef,
  TransformOperation,
  TransformSpec,
} from "./spec.js";

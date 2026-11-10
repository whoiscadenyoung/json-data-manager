/**
 * `@caden/data-core/transform` — the SQL engine the Analysis tab still uses
 * (retires in #306). The lookup / rollup executors and the TransformSpec
 * envelope went with the derived registry (#301); see
 * `@caden/data-core/views`.
 */
export { applySql, declaredColumnTypes, materializeSqlTable, sqlSourceName } from "./sql.js";
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
export type { SqlOperation, SqlTableRef } from "./spec.js";

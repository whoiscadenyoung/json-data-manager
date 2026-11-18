/**
 * `@caden/data-core/views` — the Views node-graph format, validator and Postgres
 * SQL compiler (docs/views-design.md §4, §6, §8). Pure: a definition plus
 * input metadata in, SQL text plus bind params out.
 */
export { analyzeExpression, expressionFieldRefs } from "./calculate.js";
export type { ExpressionAnalysis, FieldResolver } from "./calculate.js";
export { parseExpression } from "./calc-parser.js";
export { ExpressionError } from "./calc-ast.js";
export type { BinaryOp, ExprDiagnostic, ExprNode, ParseResult, SourceSpan } from "./calc-ast.js";
export { EXPRESSION_FUNCTIONS } from "./calc-sql.js";
export type { FunctionInfo } from "./calc-sql.js";
export { compileDiagnostics, compileView, viewInputDatasetIds } from "./compile.js";
export { ViewCompileError, ViewNodeNotSupportedError } from "./errors.js";
export { analyzeSqlStep, DENIED_FUNCTIONS } from "./sql-step.js";
export type { SqlStepAnalysis, SqlStepResult } from "./sql-step.js";
export { slugify as slugifyViewName } from "./sql-util.js";
export {
  applyExtract,
  canExtract,
  copyTitle,
  duplicateDefinition,
  freshNodeId,
  nodeLabelOfPath,
  nodeUsages,
  planExtract,
  pruneNodes,
  remapReport,
  remapSources,
  renameNodeId,
  unusedNodeIds,
} from "./reuse.js";
export type {
  ExtractPlan,
  ExtractResult,
  NodeUsage,
  RemapProblem,
  RemapReport,
  SourceRemap,
} from "./reuse.js";
export {
  dependencyOrder,
  describeCycle,
  distinctInputs,
  findCycle,
  nodeInputs,
  reachableIds,
  readersOf,
  sourceIds,
} from "./graph.js";
export type { DependencyOrder } from "./graph.js";
export { validateViewDefinition } from "./validate.js";
export type {
  AppendTag,
  ColumnEdit,
  CompileInputMeta,
  CompileOptions,
  CompiledQuery,
  Condition,
  ConditionLeaf,
  ConditionOp,
  DiagnosticsOptions,
  Expr,
  FieldType,
  JoinNode,
  KeyMatching,
  KeyPair,
  Measure,
  MeasureFn,
  MultiMatch,
  NodeKind,
  OutputField,
  OutputSchema,
  Sort,
  StackInput,
  ValidationError,
  ValidationResult,
  ViewDefinition,
  ViewInputRef,
  ViewNode,
} from "./types.js";

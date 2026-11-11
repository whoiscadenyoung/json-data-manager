/**
 * `@caden/data-core/views` — the Views step format, validator and Postgres
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
export { ViewCompileError, ViewStepNotSupportedError } from "./errors.js";
export { analyzeSqlStep, DENIED_FUNCTIONS } from "./sql-step.js";
export type { SqlStepAnalysis, SqlStepResult } from "./sql-step.js";
export { slugify as slugifyViewName } from "./sql-util.js";
export {
  applyExtract,
  canExtract,
  copyTitle,
  duplicateDefinition,
  freshAlias,
  joinAt,
  planExtract,
  pruneInputs,
  remapInputs,
  remapReport,
  stepLabelOfPath,
} from "./reuse.js";
export type {
  ExtractPlan,
  ExtractResult,
  InputRemap,
  JoinPath,
  RemapProblem,
  RemapReport,
} from "./reuse.js";
export { validateViewDefinition } from "./validate.js";
export type {
  CompileInputMeta,
  CompileOptions,
  CompiledQuery,
  Condition,
  ConditionLeaf,
  ConditionOp,
  DiagnosticsOptions,
  Expr,
  FieldType,
  JoinStep,
  KeyMatching,
  KeyPair,
  Measure,
  MeasureFn,
  MultiMatch,
  OutputField,
  OutputSchema,
  RightSide,
  Sort,
  Step,
  StepKind,
  ValidationError,
  ValidationResult,
  ViewDefinition,
  ViewInput,
  ViewInputRef,
} from "./types.js";

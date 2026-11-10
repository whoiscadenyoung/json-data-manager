/**
 * `@caden/data-core/views` — the Views step format, validator and Postgres
 * SQL compiler (docs/views-design.md §4, §6, §8). Pure: a definition plus
 * input metadata in, SQL text plus bind params out.
 */
export { compileDiagnostics, compileView, viewInputDatasetIds } from "./compile.js";
export { ViewCompileError, ViewStepNotSupportedError } from "./errors.js";
export { slugify as slugifyViewName } from "./sql-util.js";
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

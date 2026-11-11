/**
 * The Views step format (docs/views-design.md §4): a plain-JSON, serializable
 * definition that the compiler turns into one Postgres statement. The Step
 * union is complete for v1; `ViewStepNotSupportedError` is reserved for
 * later step kinds (spatial steps) the union does not name yet.
 */

export type ViewInputRef = { kind: "dataset"; id: string; version?: string };

export type ViewInput = { alias: string; ref: ViewInputRef };

export type Sort = { field: string; direction?: "asc" | "desc" };

export type ConditionOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains"
  | "isNull"
  | "notNull";

export type ConditionLeaf = { field: string; op: ConditionOp; value?: unknown };

/** A small serializable filter tree: leaves plus and / or / not branches. */
export type Condition =
  | ConditionLeaf
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };

/**
 * A calculate expression, stored as its source text (e.g. `"cost * 2"`) so
 * the editor round-trips what the user typed. `parseExpression` turns it
 * into an AST (`ExprNode`); the compiler rebuilds SQL from that AST only.
 */
export type Expr = string;

export type MeasureFn =
  | "count"
  | "countDistinct"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "topBy"
  | "text";

export type Measure = {
  as: string;
  fn: MeasureFn;
  /** Not needed for `count`. */
  field?: string;
  /** topBy: the field whose max/min picks the row. */
  by?: string;
  direction?: "max" | "min";
  /** text: the string_agg separator. */
  separator?: string;
  /** Value when nothing matched (count defaults to 0). */
  emptyValue?: string | number | boolean | null;
};

export type MultiMatch =
  | { mode: "first" | "last"; orderBy?: Sort[] }
  | { mode: "summarize"; measures: Measure[] }
  | {
      mode: "spread";
      by: string;
      value: string;
      columns: { category: string; as: string }[];
    }
  | { mode: "text"; field: string; separator: string }
  | { mode: "list" }
  | { mode: "error" };

export type KeyMatching = {
  trim: boolean;
  caseFold: boolean;
  collapseSpace: boolean;
  stripDiacritics: boolean;
  /** Applied to the left key before normalization. */
  manualMap?: { from: string; to: string }[];
};

export type KeyPair = { left: string; right: string };

export type RightSide = { input: string; steps?: Step[] };

export type JoinStep = {
  kind: "join";
  right: RightSide;
  on: KeyPair[];
  matching: KeyMatching;
  type: "left" | "inner";
  multiMatch: MultiMatch;
  fields?: string[];
  prefix?: string;
};

export type Step =
  | { kind: "filter"; where: Condition }
  | JoinStep
  | { kind: "groupBy"; by: string[]; measures: Measure[] }
  | { kind: "calculate"; field: string; expr: Expr }
  | { kind: "select"; fields: { from: string; as: string }[] }
  | { kind: "sql"; query: string };

export type StepKind = Step["kind"];

export type OutputField = {
  /** The output property name (a rename when it differs from `from`). */
  key: string;
  /** The field of the final row this column reads; defaults to `key`. */
  from?: string;
  label?: string;
  /** Kept in the saved rows but left out of tooltips and exports. */
  hidden?: boolean;
};

export type OutputSchema = {
  /** Order = display / export order. */
  fields: OutputField[];
  emptyFields: "keep" | "omit";
};

export type ViewDefinition = {
  inputs: ViewInput[];
  /** Alias of the input whose rows (and geometry) the view keeps. */
  base: string;
  steps: Step[];
  output: OutputSchema;
};

export type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "unknown";

export interface CompileInputMeta {
  /** Matches ViewDefinition.inputs[].alias. */
  alias: string;
  /** Dataset uuid. */
  datasetId: string;
  /** Dataset title, used for default join prefixes (never the uuid). */
  title: string;
  /** dataset_versions.ref when pinned. */
  pinnedVersion?: string;
  fields?: { name: string; type?: FieldType }[];
}

/** Positional $1..$n params; jsonb params are pre-serialized JSON strings. */
export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

export interface CompileOptions {
  /** Compile only steps[0..uptoStep] (inclusive), for previews. */
  uptoStep?: number;
  /** Append LIMIT (a non-negative integer). */
  limit?: number;
  /** Use the unaccent() extension for stripDiacritics (default: translate()). */
  unaccent?: boolean;
}

export interface DiagnosticsOptions {
  uptoStep?: number;
  unaccent?: boolean;
}

export type ValidationError = {
  path: string;
  message: string;
  /** For errors inside an expression / SQL string: offsets (end exclusive) into the string at `path`. */
  position?: { start: number; end: number };
};

export type ValidationResult =
  | { ok: true; value: ViewDefinition }
  | { ok: false; errors: ValidationError[] };

/**
 * The Views node-graph format (docs/views-node-graph-design.md): a plain-JSON,
 * serializable definition (named nodes, one `result`) that the compiler turns
 * into one Postgres statement. The node union stays open for later kinds.
 */

export type ViewInputRef = { kind: "dataset"; id: string; version?: string };

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

export type JoinNode = {
  kind: "join";
  /** Node ids: the rows kept (left) and the rows looked up (right). */
  left: string;
  right: string;
  on: KeyPair[];
  matching: KeyMatching;
  type: "left" | "inner";
  multiMatch: MultiMatch;
  fields?: string[];
  prefix?: string;
};

/** A scalar stamped onto stacked rows (e.g. a fiscal year). */
export type AppendTag = string | number | boolean | null;

/**
 * A per-member column edit applied to that member's rows before stacking.
 * `{ from, as }` renames / re-maps a field into another output column;
 * `{ from, exclude: true }` drops it. Untouched fields pass through.
 */
export type ColumnEdit = { from: string; as: string } | { from: string; exclude: true };

/** One stacked input: a node, its tag and its column edits (both belong to the edge). */
export type StackInput = {
  node: string;
  /** Written to the stack's `tagField` on this input's rows. */
  tag?: AppendTag;
  columns?: ColumnEdit[];
};

export type NodeKind = ViewNode["kind"];

export type ViewNode = { label?: string } & (
  | { kind: "source"; ref: ViewInputRef }
  | { kind: "filter"; from: string; where: Condition }
  | { kind: "columns"; from: string; edits: ColumnEdit[]; only?: string[] }
  | { kind: "calculate"; from: string; fields: { field: string; expr: Expr }[] }
  | { kind: "groupBy"; from: string; by: string[]; measures: Measure[] }
  | { kind: "sql"; from: string; reads?: string[]; query: string }
  | JoinNode
  | { kind: "stack"; inputs: StackInput[]; tagField?: string }
);

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
  /** Key = stable node id (a readable slug, never a dataset id). */
  nodes: Record<string, ViewNode>;
  /** The node the view saves, and how its columns are exposed. */
  result: { node: string; output: OutputSchema };
};

export type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "unknown";

export interface CompileInputMeta {
  /** Matches the id of a `source` node. */
  node: string;
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
  /** Compile only the ancestors of this node and read its rows, for previews. */
  uptoNode?: string;
  /** Append LIMIT (a non-negative integer). */
  limit?: number;
  /** Use the unaccent() extension for stripDiacritics (default: translate()). */
  unaccent?: boolean;
}

export interface DiagnosticsOptions {
  uptoNode?: string;
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

/**
 * The pure SQL engine — the escape-hatch half of the transform engine
 * (docs/analysis-layer-design.md, roadmap stage 9, #105), sibling to
 * lookup.ts and rollup.ts under the ONE engine interface (spec.ts: "One
 * engine interface"): a serializable spec variant (`SqlOperation`) plus one
 * engine function over generic records that never mutates its inputs, does
 * no I/O of its own, and imports nothing but ../coercion.js and the spec
 * types.
 *
 * The one deliberate deviation from the sibling shape, and its recorded
 * design line: the function is ASYNC and takes the database handle as its
 * fourth argument —
 *
 *     applySql(operation, rows, sideTables, engine, options?)
 *
 * `engine` is a `SqlEngine` over an in-memory, in-process SQL database
 * (DuckDB-WASM — in the analysis Web Worker interactively, in-page for
 * publish/preview parity; there is deliberately no server-side execution
 * path). The handle is injected, never imported: this module stays free of
 * any DuckDB dependency, unit-testable with a stand-in exactly like
 * rollup.test.ts, and the same pure glue serves both executors — the doc's
 * "one system" contract is this function, not a compiler (the rollup UI
 * shares only the engine interface with SQL, the open question §4:73-74
 * decides NOT to answer with compilation).
 *
 * Invariants, each pinned by a test in `sql.test.ts`:
 *
 * - **Column typing is the declared structure's, coerced through 0.4.** The
 *   invariant is analysis-layer-design.md §2:38-46 — entries are schemaless
 *   JSON, a columnar engine wants typed columns, and mixed-typed cells must
 *   coerce under the SHARED policies instead of silently splitting groups.
 *   Materialization (`materializeSqlTable`) types each column from the
 *   dataset's declared structure (falling back to first-seen inference for
 *   schemaless data), then coerces every cell:
 *   - a NUMBER column reads cells through `coerceNumber` — string "42" is
 *     42; non-numeric cells land null (SQL NULL, never 0);
 *   - a STRING column reads cells through `normalizeKey` — the canonical
 *     join-key form: number 42 → "42", strings trimmed and case-folded
 *     ("Aldine"/"aldine" group together), zero-padded "007" never folding
 *     into 7. The registered table carries canonical key form rather than
 *     display text — the price of "one group per real-world key" inside a
 *     SQL GROUP BY, recorded here so it is a decision, not a surprise;
 *   - a BOOLEAN column keeps booleans, null for everything else.
 *   Keyless cells (null/objects/arrays) are always null, never "null"
 *   strings — the lookup engine's "a keyless row is an unmatched row, never
 *   a crash" policy, extended to grouping.
 * - **Never throws.** A SQL syntax error, unknown table, or engine failure
 *   is a normal outcome of user-authored text: it lands in
 *   `diagnostics.error` and the result rows come back empty. Nothing in a
 *   preview or a publish should crash on a bad query — publish treats a
 *   non-undefined error as its rejection (publish-spec.ts).
 * - **Purity.** Input arrays and rows are never written; every materialized
 *   and output row is a fresh object. The engine handle is trusted to be
 *   in-memory compute — the same trust `sideTables` gives the caller in
 *   lookup.ts.
 * - **Result caps are the caller's build-time decision**, passed in
 *   (`options.limit`), not hardcoded here — the worker and the publish path
 *   may bound differently. Truncation is REPORTED (`diagnostics.truncated`
 *   with pre-cap `resultRows`), never silent: a silently cut result set
 *   would fabricate aggregates. The publish executor treats `truncated` as
 *   a refusal (publish-spec.ts) — the interactive preview shows it as a
 *   badge, but materializing the first N rows as the complete dataset is
 *   exactly the fabrication the reporting exists to prevent.
 * - **Read-only is statement-enforced.** Exactly one statement, and it must
 *   be a SELECT — a bare one, or a WITH whose CTE chain ends in a SELECT.
 *   The main verb after the CTEs is checked too, not just the head: the
 *   pinned DuckDB parses `WITH t AS (SELECT 1) DELETE FROM …` fine
 *   (probe-verified 2026-09-30) and would execute it against the ephemeral
 *   database. The gate sits in `sqlSetupError`, before the engine is
 *   touched, so both executors inherit it. It scans comments and quoted
 *   regions away first (line comments, nestable block comments — the
 *   engine nests too —, single/double/backtick quotes, E'' backslash
 *   escapes, $$ dollar quoting), so a quote character inside a comment can
 *   no longer desynchronize the scan into missing a second statement
 *   (#132). DuckDB hosts add a second, engine-level layer — the engine is
 *   created with external access disabled and its configuration locked
 *   (app/src/lib/analysis-duckdb.ts) — because this package must stay
 *   engine-free and the pinned duckdb-wasm exposes no statement-extraction
 *   API to prefer. `EXPLAIN`/`DESCRIBE` and friends are refused (not
 *   analyses).
 * - **A stored spec that omits `tables` is tolerated by the engine**
 *   (`?? []`): the field is required on the type and at the save gate, but
 *   storage is `v.any()` and the never-throws contract covers stored data
 *   as it exists.
 * - **Diagnostics are operation-shaped** (spec.ts: no shared result
 *   contract): rows in, the tables registered, rows out, truncation, and
 *   the error when the query failed.
 */
import { coerceNumber, normalizeKey } from "../coercion.js";
import type { SqlOperation } from "./spec.js";

/** The column types a columnar registration supports (the declared-structure subset that matters for grouping/joining). */
export type SqlColumnType = "boolean" | "number" | "string";

/** One column's name and materialized type. */
export interface SqlColumnSpec {
  name: string;
  type: SqlColumnType;
}

/** One table to register: its SQL name, effective columns, and materialized rows. */
export interface SqlTable {
  columns: SqlColumnSpec[];
  name: string;
  rows: Array<Record<string, unknown>>;
}

/**
 * The database handle `applySql` runs through — over an in-memory SQL
 * database (DuckDB-WASM in this app). `register` makes the table queryable
 * by name (create-or-replace: two runs of the same query must not see each
 * other's tables); `query` runs one read-only statement and returns plain
 * records. Implementations own their own caps/limits beyond
 * `options.limit` — the worker sets memory_limit at instantiation.
 */
export interface SqlEngine {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
  register(table: SqlTable): Promise<void>;
}

/** A side table's rows plus its dataset's declared column types, keyed by the operation's `as` name. */
export interface SqlSideTable {
  columns?: readonly SqlColumnSpec[];
  rows: readonly Record<string, unknown>[];
}

/** Diagnostics for one `applySql` call — operation-shaped (see the module doc). */
export interface SqlDiagnostics {
  /** The failure that produced empty rows — absent on success. */
  error?: string;
  /** The SQL names registered for this run (source first), in registration order. */
  tables: string[];
  /** Rows in — the source table's row count. */
  totalSourceRows: number;
  /** Rows the query returned BEFORE any limit — stated so truncation is visible. */
  resultRows: number;
  /** True when the returned rows were cut to `options.limit`. */
  truncated: boolean;
}

/** The result of one `applySql` call: query output (plain records) plus diagnostics. */
export interface SqlResult {
  rows: Array<Record<string, unknown>>;
  diagnostics: SqlDiagnostics;
}

/** The run-level options: the source's declared columns and the result-row cap. */
export interface SqlApplyOptions {
  /** Declared column types of the source dataset — absent → inferred from the rows. */
  sourceColumns?: readonly SqlColumnSpec[];
  /** Maximum rows returned; a longer result truncates with `truncated: true`. */
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declared type of one property, read through the array (`["string","null"]`) or plain (`"string"`) form — null when neither maps to a supported scalar. */
function declaredBaseType(
  declared: unknown,
): "boolean" | "integer" | "number" | SqlColumnType | undefined {
  const base: unknown = Array.isArray(declared)
    ? declared.find((entry) => typeof entry === "string" && entry !== "null")
    : declared;
  if (base === "boolean" || base === "number" || base === "integer" || base === "string") {
    return base;
  }
  return undefined;
}

/**
 * The declared column types of a stored JSON Schema document (the component
 * import-time inference shape: `properties.<name>.type` a string or a
 * `["string", "null"]` array) as SQL column specs, first-seen order. The
 * worker and the publish path both adapt `schemas.get` docs through this,
 * so the registered table's typing can never drift from the declared
 * structure (the §2:38-46 invariant's first half). Properties without a
 * recognizable scalar type are omitted — they fall to row inference.
 */
export function declaredColumnTypes(schemaJson: unknown): SqlColumnSpec[] {
  if (!isRecord(schemaJson) || !isRecord(schemaJson.properties)) {
    return [];
  }
  const columns: SqlColumnSpec[] = [];
  for (const [name, property] of Object.entries(schemaJson.properties)) {
    const base = declaredBaseType(isRecord(property) ? property.type : undefined);
    if (base !== undefined) {
      columns.push({ name, type: base === "integer" ? "number" : base });
    }
  }
  return columns;
}

/** One cell's contribution to its column's inference: "number"-eligible, "boolean", or genuinely other. */
function inferCellClass(cell: unknown): "boolean" | "number" | "other" {
  if (typeof cell === "number") {
    return "number";
  }
  if (typeof cell === "boolean") {
    return "boolean";
  }
  if (typeof cell === "string" && coerceNumber(cell) !== undefined) {
    // A numeric string stays number-eligible (the coerceNumber policy
    // decides at materialization); anything else is genuinely textual.
    return "number";
  }
  return "other";
}

/** The effective type of one column from its cells: all numeric → number, all boolean → boolean, else string. */
function inferColumnType(rows: readonly Record<string, unknown>[], name: string): SqlColumnType {
  const classes = rows
    .map((row) => row[name])
    .filter((cell) => cell !== null && cell !== undefined)
    .map(inferCellClass);
  if (classes.every((entry) => entry === "number")) {
    return "number";
  }
  return classes.every((entry) => entry === "boolean") ? "boolean" : "string";
}

/** One cell as its SQL value under the column's type — the 0.4 coercion policies, per the module doc. */
function materializeCell(cell: unknown, type: SqlColumnType): unknown {
  if (type === "number") {
    return coerceNumber(cell) ?? null;
  }
  if (type === "boolean") {
    return typeof cell === "boolean" ? cell : null;
  }
  return normalizeKey(cell) ?? null;
}

/**
 * Materializes one dataset's rows as a typed SQL table (see the module doc
 * for the coercion policies). Columns: the declared types first (first-seen
 * order), then any undeclared keys the rows carry, inferred. Inputs are
 * never mutated; every row is fresh.
 */
export function materializeSqlTable(
  name: string,
  rows: readonly Record<string, unknown>[],
  declaredColumns?: readonly SqlColumnSpec[],
): SqlTable {
  const declaredByName = new Map(
      (declaredColumns ?? []).map((column) => [column.name, column.type]),
    ),
    extraNames: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!declaredByName.has(key) && !extraNames.includes(key)) {
        extraNames.push(key);
      }
    }
  }
  const columns: SqlColumnSpec[] = [
    ...(declaredColumns ?? []),
    ...extraNames.map((extra) => ({ name: extra, type: inferColumnType(rows, extra) })),
  ];
  const materialized = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) {
      out[column.name] = materializeCell(row[column.name], column.type);
    }
    return out;
  });
  return { columns, name, rows: materialized };
}

/** The SQL name the source registers under (the recorded default). */
export function sqlSourceName(operation: SqlOperation): string {
  return operation.sourceAs ?? "source";
}

/** One side table materialized under its SQL name — an absent side (not yet streamed) registers empty rather than fabricating an error. */
function materializeSideTable(
  name: string,
  sideTables: ReadonlyMap<string, SqlSideTable>,
): SqlTable {
  const side = sideTables.get(name),
    sideRows = side === undefined ? [] : side.rows,
    sideColumns = side === undefined ? undefined : side.columns;
  return materializeSqlTable(name, sideRows, sideColumns);
}

/** The setup problem that must stop the run before the engine is touched, or undefined. */
function sqlSetupError(sql: string, names: readonly string[]): string | undefined {
  const tokens = sqlTokens(sql);
  if (tokens.length === 0) {
    // Whitespace- or comment-only input — there is no statement to gate.
    return "The analysis has no SQL query to run yet.";
  }
  const statementError = readOnlyStatementError(tokens);
  if (statementError !== undefined) {
    return statementError;
  }
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  return duplicate === undefined ? undefined : `Table name "${duplicate}" is used more than once.`;
}

/** The token kinds the statement gate reads; everything else (whitespace, comments, quoted regions, punctuation) is dropped at the scan. */
type SqlTokenKind = "closeParen" | "comma" | "openParen" | "semicolon" | "word";

/** One scanned token: a word (upper-cased — SQL keywords are case-insensitive), a separator, a comma, or a parenthesis. */
interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

const WORD_CHARACTER = /[A-Za-z0-9_$]/,
  DOLLAR_QUOTE_HEAD = /^\$[A-Za-z_]*\$/,
  SEPARATOR_KINDS: Record<string, SqlTokenKind> = {
    "(": "openParen",
    ")": "closeParen",
    ",": "comma",
    ";": "semicolon",
  },
  READ_ONLY_MESSAGE =
    "Analyses run read-only SELECT queries (or a WITH … SELECT) — nothing else executes here.";

/** The index just past a `--` line comment opened at `start` (an unterminated one runs to the end). */
function pastLineComment(sql: string, start: number): number {
  const newline = sql.indexOf("\n", start);
  return newline === -1 ? sql.length : newline + 1;
}

/** The index just past a block comment opened at `start`, nesting like the engine does (probe-verified on the pinned build). */
function pastBlockComment(sql: string, start: number): number {
  let depth = 1,
    index = start + 2;
  while (index < sql.length && depth > 0) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
    } else if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

/** The index just past a dollar-quoted region ($$…$$ or $tag$…$tag$) opened at `start`, or undefined when the characters there do not open one (a bare `$` is ordinary). */
function pastDollarQuote(sql: string, start: number): number | undefined {
  const match = DOLLAR_QUOTE_HEAD.exec(sql.slice(start, start + 64));
  if (match === null) {
    return undefined;
  }
  const closer = sql.indexOf(match[0], start + match[0].length);
  return closer === -1 ? sql.length : closer + match[0].length;
}

/** The index just past a quoted region (string literal or quoted identifier) opened at `start` — the doubled quote is the escape, and a `backslashEscapes` region (the engine's E'' strings) escapes its next character. An unterminated region consumes the rest of the input. */
function pastQuotedRegion(sql: string, start: number, backslashEscapes: boolean): number {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === "\\") {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        // The doubled quote is the escape — the region continues.
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return index;
}

/** The token one separator/parenthesis character produces, or undefined for any other character. */
function separatorToken(character: string): SqlToken | undefined {
  const kind = SEPARATOR_KINDS[character];
  return kind === undefined ? undefined : { kind, text: "" };
}

/**
 * Scans one SQL string into the tokens the statement gate reads, dropping
 * comments and quoted regions so their contents can never read as syntax:
 * `--` line comments and nestable block comments (the engine nests them
 * too — probe-verified on the pinned build); single-quoted strings and
 * double-/backtick-quoted identifiers (doubled-quote escape, plus
 * backslash escapes after a bare `E` prefix — the engine's E'' rule); and
 * $$ / $tag$ dollar quoting, whose contents the engine treats as one
 * literal. A quote character inside a comment therefore cannot desync the
 * scan into missing a real second statement — the #132 defect — and a
 * semicolon inside any quoted region cannot read as a separator.
 */
function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const past = pastCommentOrQuote(sql, index, tokens);
    if (past !== undefined) {
      index = past;
      continue;
    }
    const character = sql[index];
    if (WORD_CHARACTER.test(character)) {
      let end = index + 1;
      while (end < sql.length && WORD_CHARACTER.test(sql[end])) {
        end += 1;
      }
      tokens.push({ kind: "word", text: sql.slice(index, end).toUpperCase() });
      index = end;
      continue;
    }
    const separator = separatorToken(character);
    if (separator !== undefined) {
      tokens.push(separator);
    }
    index += 1;
  }
  return tokens;
}

/** True when a single quote continues the engine's backslash-escaped E'' string syntax — the token before it is the bare word E. */
function singleQuoteEscapes(tokens: readonly SqlToken[], character: string): boolean {
  const previous = tokens[tokens.length - 1];
  return (
    character === "'" &&
    previous !== undefined &&
    previous.kind === "word" &&
    previous.text === "E"
  );
}

/** The index just past the comment or quoted region opening at `start`, or undefined when ordinary characters sit there. */
function pastCommentOrQuote(sql: string, start: number, tokens: readonly SqlToken[]): number | undefined {
  const character = sql[start];
  if (character === "-" && sql[start + 1] === "-") {
    return pastLineComment(sql, start);
  }
  if (character === "/" && sql[start + 1] === "*") {
    return pastBlockComment(sql, start);
  }
  if (character === "$") {
    return pastDollarQuote(sql, start);
  }
  if (character === "'" || character === '"' || character === "`") {
    return pastQuotedRegion(sql, start, singleQuoteEscapes(tokens, character));
  }
  return undefined;
}

/** The upper-cased word at `index`, or "" when no word token sits there. */
function wordAt(tokens: readonly SqlToken[], index: number): string {
  const token = tokens[index];
  return token !== undefined && token.kind === "word" ? token.text : "";
}

/** The kind of the token at `index`, or undefined past the end. */
function kindAt(tokens: readonly SqlToken[], index: number): SqlTokenKind | undefined {
  const token = tokens[index];
  return token === undefined ? undefined : token.kind;
}

/** The index just past the group opened at `openIndex`, or undefined when the parens never balance. */
function pastBalancedParens(tokens: readonly SqlToken[], openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const kind = kindAt(tokens, index);
    if (kind === "openParen") {
      depth += 1;
    } else if (kind === "closeParen") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

/** The index just past one CTE's `name [(columns)]` head, or undefined when no name (plus optional column list) sits at `index`. */
function pastCteHead(tokens: readonly SqlToken[], index: number): number | undefined {
  if (wordAt(tokens, index) === "") {
    return undefined;
  }
  const afterName = index + 1;
  if (kindAt(tokens, afterName) !== "openParen") {
    return afterName;
  }
  return pastBalancedParens(tokens, afterName);
}

/** The index just past one CTE's `AS [NOT] [MATERIALIZED] (query)` tail, or undefined when it does not sit at `index`. */
function pastCteTail(tokens: readonly SqlToken[], index: number): number | undefined {
  if (wordAt(tokens, index) !== "AS") {
    return undefined;
  }
  let cursor = index + 1;
  if (wordAt(tokens, cursor) === "NOT") {
    cursor += 1;
  }
  if (wordAt(tokens, cursor) === "MATERIALIZED") {
    cursor += 1;
  }
  if (kindAt(tokens, cursor) !== "openParen") {
    return undefined;
  }
  return pastBalancedParens(tokens, cursor);
}

/**
 * The WITH chain walk: over `[RECURSIVE] name [(cols)] AS [NOT]
 * [MATERIALIZED] (query)` groups, then the main query. Returns undefined
 * only when that main query is a SELECT — a `WITH … DELETE/INSERT/UPDATE`
 * parses and executes on the pinned engine (probe-verified 2026-09-30), so
 * the head keyword alone proves nothing. A malformed chain fails closed.
 */
function withChainError(tokens: readonly SqlToken[]): string | undefined {
  let index = 1;
  if (wordAt(tokens, index) === "RECURSIVE") {
    index += 1;
  }
  while (index < tokens.length) {
    const head = pastCteHead(tokens, index);
    if (head === undefined) {
      return READ_ONLY_MESSAGE;
    }
    const tail = pastCteTail(tokens, head);
    if (tail === undefined) {
      return READ_ONLY_MESSAGE;
    }
    index = tail;
    if (kindAt(tokens, index) === "comma") {
      index += 1;
      continue;
    }
    break;
  }
  return wordAt(tokens, index) === "SELECT" ? undefined : READ_ONLY_MESSAGE;
}

/** True when a separator is followed by any further token — the tokenizer already dropped comments and quoted regions, so trailing `; -- done` scans clean. */
function hasSecondStatement(tokens: readonly SqlToken[]): boolean {
  const separator = tokens.findIndex((token) => token.kind === "semicolon");
  return separator !== -1 && separator + 1 < tokens.length;
}

/**
 * The read-only statement gate: exactly ONE statement (no top-level
 * semicolon separators), and it must be a SELECT — bare, or a WITH chain
 * ending in one. This is what makes the "read-only" promise
 * statement-enforced rather than structural — an INSERT/CREATE/DROP/ATTACH
 * would otherwise succeed against the worker's ephemeral database and just
 * surprise whoever runs the next query. The scan is comment- and
 * quote-aware (sqlTokens above); `EXPLAIN`/`DESCRIBE` and friends are
 * refused (not analyses).
 */
function readOnlyStatementError(tokens: readonly SqlToken[]): string | undefined {
  if (hasSecondStatement(tokens)) {
    return "Run one statement at a time — the analysis takes a single SELECT.";
  }
  const head = wordAt(tokens, 0);
  if (head === "SELECT") {
    return undefined;
  }
  return head === "WITH" ? withChainError(tokens) : READ_ONLY_MESSAGE;
}

/** The run options unwrapped once (absent options object → both undefined). */
function applyOptionsOf(options: SqlApplyOptions | undefined): {
  limit: number | undefined;
  sourceColumns: readonly SqlColumnSpec[] | undefined;
} {
  return {
    limit: options === undefined ? undefined : options.limit,
    sourceColumns: options === undefined ? undefined : options.sourceColumns,
  };
}

/**
 * Applies one sql operation (stage 9, #105): materialize the source rows
 * and every named side table into typed tables (0.4 coercion), register
 * them under their SQL names, run the query, cap the result. Never throws —
 * a failed query is `diagnostics.error` with empty rows (see the module
 * doc). `sideTables` keys are the operation's `as` names; a ref whose side
 * table is absent registers with zero rows (an unloaded side must not
 * fabricate an error a missing-table message would mask — the worker gates
 * completeness upstream, same as the popup executor's rule).
 */
export async function applySql(
  operation: SqlOperation,
  rows: readonly Record<string, unknown>[],
  sideTables: ReadonlyMap<string, SqlSideTable>,
  engine: SqlEngine,
  options?: SqlApplyOptions,
): Promise<SqlResult> {
  // The field is required on the stored type, but the save gate's
  // structural tolerance means a LEGAL stored spec may omit it — the
  // never-throws contract applies to stored data as it exists, so the
  // engine defaults rather than dereferencing (pinned by sql.test.ts).
  const { limit, sourceColumns } = applyOptionsOf(options),
    tableRefs = operation.tables ?? [],
    sourceName = sqlSourceName(operation),
    names = [sourceName, ...tableRefs.map((table) => table.as)];
  const base = {
    resultRows: 0,
    tables: names,
    totalSourceRows: rows.length,
    truncated: false,
  };
  const setupError = sqlSetupError(operation.sql, names);
  if (setupError !== undefined) {
    return {
      rows: [],
      diagnostics: { ...base, error: setupError },
    };
  }
  const tables = [
    materializeSqlTable(sourceName, rows, sourceColumns),
    ...tableRefs.map((ref) => materializeSideTable(ref.as, sideTables)),
  ];
  try {
    for (const table of tables) {
      // oxlint-disable-next-line no-await-in-loop -- registration is per table, in name order; each table must exist before the query runs.
      await engine.register(table);
    }
    const result = await engine.query(operation.sql);
    return {
      rows: limit === undefined || result.length <= limit ? [...result] : result.slice(0, limit),
      diagnostics: {
        ...base,
        resultRows: result.length,
        truncated: limit !== undefined && result.length > limit,
      },
    };
  } catch (error) {
    return {
      rows: [],
      diagnostics: {
        ...base,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

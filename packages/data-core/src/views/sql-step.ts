/**
 * The `sql` step (docs/views-design.md §6, ADR 0028 D13): parse the user's
 * query with a real Postgres parser (pgsql-ast-parser, pure TypeScript),
 * enforce the safety rules, and work out how its output folds into a row.
 *
 * Rules: exactly one statement; a SELECT (or UNION / VALUES / WITH ... SELECT);
 * no data-modifying CTEs; no `$n` parameters; table references limited to the
 * declared inputs (`in_<alias>`), the previous step (`prev`) and CTEs defined
 * in the query itself. Function calls are allowed except a small denylist of
 * functions that run nested SQL text, touch files or sequences, or change
 * settings; the server runs the query read-only as `authenticated` with a
 * timeout, so nothing else is reachable.
 *
 * Output shape (documented choice): the final SELECT's output columns are
 * classified by NAME, which is why every output column must be nameable:
 *   - `d` (jsonb): the row's properties. Other columns, if any, are merged in.
 *   - no `d`: every column except `row_id` / `geom` becomes a property.
 *   - `row_id` (uuid): optional row identity; a deterministic one is derived
 *     from the row otherwise.
 *   - `geom` (geometry): optional; without it the step drops geometry.
 * `select * from prev ...` therefore keeps everything (row_id, d, geom).
 */

import { astVisitor, parse } from "pgsql-ast-parser";
import type {
  Expr,
  From,
  SelectStatement,
  SelectedColumn,
  Statement,
  WithStatementBinding,
} from "pgsql-ast-parser";

import type { ExprDiagnostic } from "./calc-ast.js";

/** Functions that execute nested SQL text, touch files / sequences / settings, or manage backends. */
export const DENIED_FUNCTIONS = new Set([
  "set_config",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "nextval",
  "setval",
  "lo_import",
  "lo_export",
  "lo_create",
  "lo_unlink",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",
  "schema_to_xml",
  "database_to_xml",
  "cursor_to_xml",
  "dblink",
  "dblink_exec",
]);

export const PREV_NAME = "prev";
const ROW_COLUMNS = ["row_id", "d", "geom"];
const UNNAMED = "?column?";

export interface SqlStepAnalysis {
  /** Statement text, with any trailing `;` and comments after it removed. */
  query: string;
  /** Output column names (all named, no duplicates). */
  columns: string[];
  /** `in_<alias>` names the query reads. */
  inputNames: string[];
  /** Spans of the `prev` table references to rewrite (and whether each already has an alias). */
  prevRefs: { start: number; end: number; aliased: boolean }[];
}

export type SqlStepResult =
  | { ok: true; analysis: SqlStepAnalysis }
  | { ok: false; errors: ExprDiagnostic[] };

// --- parsing ----------------------------------------------------------------

function offsetOf(text: string, line: number, col: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (const earlier of lines.slice(0, line - 1)) {
    offset += earlier.length + 1;
  }
  return Math.min(text.length, offset + Math.max(0, col - 1));
}

function syntaxError(query: string, error: unknown): ExprDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const match = /line (\d+) col (\d+)/.exec(message);
  const pos = match === null ? 0 : offsetOf(query, Number(match[1]), Number(match[2]));
  const head = message.split("\n")[0].replace(/^Error:\s*/, "");
  return { message: `SQL syntax error: ${head}`, start: pos, end: Math.min(query.length, pos + 1) };
}

function whole(query: string, message: string): ExprDiagnostic {
  return { message, start: 0, end: query.length };
}

function at(
  node: { _location?: { start: number; end: number } },
  query: string,
  message: string,
): ExprDiagnostic {
  const loc = node._location;
  return loc === undefined
    ? whole(query, message)
    : { message, start: loc.start, end: Math.max(loc.start, loc.end) };
}

function isSelectLike(statement: Statement): statement is SelectStatement {
  return (
    statement.type === "select" ||
    statement.type === "union" ||
    statement.type === "union all" ||
    statement.type === "values" ||
    statement.type === "with" ||
    statement.type === "with recursive"
  );
}

// --- the visitor ------------------------------------------------------------

interface Findings {
  errors: ExprDiagnostic[];
  tables: { name: string; start: number; end: number; aliased: boolean; schema?: string }[];
  ctes: Set<string>;
}

function visit(statement: SelectStatement, query: string): Findings {
  const found: Findings = { errors: [], tables: [], ctes: new Set() };
  const visitor = astVisitor((v) => ({
    statement: (s) => {
      if (!isSelectLike(s)) {
        found.errors.push(at(s, query, `Only SELECT queries are allowed (found ${s.type}).`));
      }
      if (s.type === "select" && s.for !== undefined) {
        found.errors.push(at(s, query, "Locking clauses (FOR UPDATE / SHARE) are not allowed."));
      }
      v.super().statement(s);
    },
    with: (w) => {
      for (const bind of w.bind) {
        found.ctes.add(bind.alias.name);
      }
      v.super().with(w);
    },
    withRecursive: (w) => {
      found.errors.push(at(w, query, "Recursive queries are not supported."));
    },
    tableRef: (t) => {
      const loc = t._location;
      found.tables.push({
        name: t.name,
        schema: t.schema,
        start: loc === undefined ? 0 : loc.start,
        end: loc === undefined ? 0 : loc.end,
        aliased: t.alias !== undefined,
      });
    },
    parameter: (p) => {
      found.errors.push(at(p, query, "Query parameters ($1, ...) are not allowed."));
    },
    call: (c) => {
      checkFunction(c, query, found);
      v.super().call(c);
    },
    fromCall: (c) => {
      checkFunction(c, query, found);
      v.super().fromCall(c);
    },
  }));
  visitor.statement(statement);
  return found;
}

function checkFunction(
  call: { function: { name: string; schema?: string }; _location?: { start: number; end: number } },
  query: string,
  found: Findings,
): void {
  if (DENIED_FUNCTIONS.has(call.function.name.toLowerCase())) {
    found.errors.push(at(call, query, `The function ${call.function.name}() is not allowed.`));
  }
}

// --- table references -------------------------------------------------------

const IDENTIFIER_AT = /^(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/;

/**
 * Where the table name starting at `start` ends. The parser's table span
 * also covers `as alias` when written with AS (and not otherwise), so the
 * name token is measured from the source text.
 */
function identifierEnd(query: string, start: number): number {
  const match = IDENTIFIER_AT.exec(query.slice(start));
  return start + (match === null ? PREV_NAME.length : match[0].length);
}

function classifyTables(
  found: Findings,
  inputAliases: string[],
  query: string,
): { inputNames: string[]; prevRefs: SqlStepAnalysis["prevRefs"] } {
  const inputNames = new Set(inputAliases.map((alias) => `in_${alias}`));
  const used = new Set<string>();
  const prevRefs: SqlStepAnalysis["prevRefs"] = [];
  for (const cte of found.ctes) {
    if (cte === PREV_NAME || inputNames.has(cte)) {
      found.errors.push(whole(query, `"${cte}" is reserved and cannot be redefined with WITH.`));
    }
  }
  for (const table of found.tables) {
    const span = { start: table.start, end: table.end };
    if (table.schema !== undefined) {
      found.errors.push({
        ...span,
        message: `Schema-qualified table "${table.schema}.${table.name}" is not allowed; use prev or an input.`,
      });
    } else if (table.name === PREV_NAME) {
      prevRefs.push({
        start: table.start,
        end: identifierEnd(query, table.start),
        aliased: table.aliased,
      });
    } else if (inputNames.has(table.name)) {
      used.add(table.name);
    } else if (!found.ctes.has(table.name)) {
      const allowed = [PREV_NAME, ...inputNames].join(", ");
      found.errors.push({
        ...span,
        message: `Unknown table "${table.name}". A sql step may read only: ${allowed}.`,
      });
    }
  }
  return { inputNames: [...used], prevRefs };
}

// --- output columns ---------------------------------------------------------

type ColumnScope = Map<string, string[]>;

function exprName(expr: Expr): string {
  if (expr.type === "ref") {
    return expr.name;
  }
  if (expr.type === "cast") {
    return exprName(expr.operand);
  }
  if (expr.type === "call") {
    return expr.function.name;
  }
  return UNNAMED;
}

/** Output names of a statement, or an error message. */
function outputColumns(
  statement: WithStatementBinding,
  scope: ColumnScope,
  inputNames: Set<string>,
): string[] | string {
  switch (statement.type) {
    case "select":
      return selectColumns(statement, scope, inputNames);
    case "union":
    case "union all":
      return outputColumns(statement.left, scope, inputNames);
    case "with": {
      const inner: ColumnScope = new Map(scope);
      for (const bind of statement.bind) {
        const cols = outputColumns(bind.statement, inner, inputNames);
        inner.set(bind.alias.name, typeof cols === "string" ? [] : cols);
      }
      return outputColumns(statement.in, inner, inputNames);
    }
    case "values": {
      const width = statement.values.length > 0 ? statement.values[0].length : 0;
      return Array.from({ length: width }, (_, i) => `column${i + 1}`);
    }
    default:
      return "Cannot determine this query's output columns.";
  }
}

function fromColumns(from: From, scope: ColumnScope, inputNames: Set<string>): string[] | string {
  if (from.type === "table") {
    const name = from.name.name;
    if (name === PREV_NAME || inputNames.has(name)) {
      return ROW_COLUMNS;
    }
    return scope.get(name) ?? `Cannot expand * over "${name}"; list its columns.`;
  }
  if (from.type === "statement") {
    return outputColumns(from.statement, scope, inputNames);
  }
  return "Cannot expand * over a function call; list the columns.";
}

function fromLabel(from: From): string {
  if (from.type === "table") {
    return from.name.alias ?? from.name.name;
  }
  if (from.type === "statement") {
    return from.alias;
  }
  return from.alias === undefined ? from.function.name : from.alias.name;
}

function wildcardColumns(
  column: SelectedColumn,
  fromList: From[],
  scope: ColumnScope,
  inputNames: Set<string>,
): string[] | string {
  const expr = column.expr;
  const qualifier = expr.type === "ref" && expr.table !== undefined ? expr.table.name : undefined;
  const sources =
    qualifier === undefined ? fromList : fromList.filter((f) => fromLabel(f) === qualifier);
  if (sources.length === 0) {
    return "Cannot expand *: no matching table in FROM.";
  }
  const names: string[] = [];
  for (const source of sources) {
    const cols = fromColumns(source, scope, inputNames);
    if (typeof cols === "string") {
      return cols;
    }
    names.push(...cols);
  }
  return names;
}

function selectColumns(
  statement: Extract<WithStatementBinding, { type: "select" }>,
  scope: ColumnScope,
  inputNames: Set<string>,
): string[] | string {
  const names: string[] = [];
  for (const column of statement.columns ?? []) {
    if (column.alias === undefined && column.expr.type === "ref" && column.expr.name === "*") {
      const expanded = wildcardColumns(column, statement.from ?? [], scope, inputNames);
      if (typeof expanded === "string") {
        return expanded;
      }
      names.push(...expanded);
    } else {
      names.push(column.alias === undefined ? exprName(column.expr) : column.alias.name);
    }
  }
  return names;
}

function checkColumnNames(names: string[], query: string): ExprDiagnostic[] {
  const errors: ExprDiagnostic[] = [];
  if (names.includes(UNNAMED)) {
    errors.push(whole(query, "Give every output column a name with `as`."));
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name) && name !== UNNAMED) {
      errors.push(whole(query, `Duplicate output column "${name}".`));
    }
    seen.add(name);
  }
  return errors;
}

// --- entry point ------------------------------------------------------------

function parseSingle(query: string): { statement: SelectStatement; text: string } | ExprDiagnostic {
  if (query.trim() === "") {
    return whole(query, "The query is empty.");
  }
  let parsed: Statement[];
  try {
    parsed = parse(query, { locationTracking: true });
  } catch (error) {
    return syntaxError(query, error);
  }
  if (parsed.length === 0) {
    return whole(query, "The query is empty.");
  }
  if (parsed.length > 1) {
    return whole(query, "Only one statement is allowed (found several separated by ;).");
  }
  const [statement] = parsed;
  if (!isSelectLike(statement)) {
    return whole(query, `Only SELECT queries are allowed (found ${statement.type}).`);
  }
  return { statement, text: statementText(query) };
}

/**
 * The statement without its terminating `;` (and anything after it). The
 * parser's statement end offsets are not reliable (they can stop before a
 * trailing alias), so cut at the first `;` whose head still parses.
 */
function statementText(query: string): string {
  let semicolon = query.indexOf(";");
  while (semicolon !== -1) {
    const head = query.slice(0, semicolon);
    try {
      if (parse(head).length === 1) {
        return head.trimEnd();
      }
    } catch {
      // The `;` sits inside a string or comment; try the next one.
    }
    semicolon = query.indexOf(";", semicolon + 1);
  }
  return query.trimEnd();
}

function isDiagnostic(value: unknown): value is ExprDiagnostic {
  return typeof value === "object" && value !== null && "message" in value;
}

/**
 * Parse and check a sql step. `inputAliases` are the view's declared input
 * aliases (the step may read `in_<alias>` for any of them).
 */
export function analyzeSqlStep(query: string, inputAliases: string[]): SqlStepResult {
  const parsed = parseSingle(query);
  if (isDiagnostic(parsed)) {
    return { ok: false, errors: [parsed] };
  }
  const found = visit(parsed.statement, query);
  const { inputNames, prevRefs } = classifyTables(found, inputAliases, query);
  const names = new Set(inputAliases.map((alias) => `in_${alias}`));
  const columns = outputColumns(parsed.statement, new Map(), names);
  if (typeof columns === "string") {
    found.errors.push(whole(query, columns));
  } else {
    found.errors.push(...checkColumnNames(columns, query));
  }
  if (found.errors.length > 0 || typeof columns === "string") {
    return { ok: false, errors: found.errors };
  }
  return { ok: true, analysis: { query: parsed.text, columns, inputNames, prevRefs } };
}

/** The statement text with `prev` pointed at the previous step's CTE. */
export function rewritePrev(analysis: SqlStepAnalysis, prevCte: string): string {
  let text = analysis.query;
  const refs = analysis.prevRefs.toSorted((a, b) => b.start - a.start);
  for (const ref of refs) {
    const replacement = ref.aliased ? prevCte : `${prevCte} as ${PREV_NAME}`;
    text = text.slice(0, ref.start) + replacement + text.slice(ref.end);
  }
  return text;
}

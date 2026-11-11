/**
 * Pre-flight checks for a Scratch query (#306). The database is the real
 * guard (a read-only, always-rolled-back transaction as `authenticated`, a
 * statement timeout, the row cap, and the subquery wrapper that makes a
 * stacked statement a syntax error). These checks only give the common
 * mistakes a clear message BEFORE a round trip, and refuse the few functions
 * a read-only transaction does NOT stop:
 *
 * - `set_config` could rewrite `request.jwt.claims` mid-statement, and RLS
 *   (`auth.uid()`) reads it per row, so a scratch query could read AS someone
 *   else. The rest of the list runs nested SQL text, touches files, sequences
 *   or backends, or sleeps.
 *
 * The denylist mirrors `DENIED_FUNCTIONS` of the compiler's `analyzeSqlStep`
 * (feat/views-4-compiler, sql-step.ts). When that lands, call the analyzer
 * here instead and delete this copy. The scan is textual and deliberately
 * conservative: it also trips on the name inside a string literal.
 */

export const DENIED_FUNCTIONS: readonly string[] = [
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
];

const NOT_READ_ONLY =
  "Scratch queries are read-only: write a single SELECT (or WITH … SELECT). Nothing here can change data.";

const WRITE_KEYWORDS =
  /^(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|do|set|reset|vacuum|analyze|lock|listen|notify|begin|start|commit|rollback|savepoint|prepare|execute|explain)\b/i;

/** Leading whitespace and SQL comments (line and block) removed. */
function withoutLeadingNoise(sql: string): string {
  let rest = sql;
  for (;;) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      rest = newline === -1 ? "" : trimmed.slice(newline + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      rest = end === -1 ? "" : trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

/** The statement without trailing whitespace and `;`. */
export function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/, "");
}

export type GuardResult = { ok: true; sql: string } | { ok: false; error: string };

export function guardScratchSql(raw: string): GuardResult {
  const sql = stripTrailingSemicolons(raw);
  const head = withoutLeadingNoise(sql);
  if (head === "") {
    return { ok: false, error: "Write a SELECT query to run." };
  }
  if (WRITE_KEYWORDS.test(head)) {
    return { ok: false, error: NOT_READ_ONLY };
  }
  // A unicode-escaped identifier (U&"set\005fconfig") would slip past the name scan.
  if (/\bu&\s*["']/i.test(sql)) {
    return {
      ok: false,
      error: 'Unicode-escaped identifiers (U&"…") are not allowed in a scratch query.',
    };
  }
  const lowered = sql.toLowerCase();
  for (const name of DENIED_FUNCTIONS) {
    if (new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(lowered)) {
      return { ok: false, error: `The function ${name}() is not allowed in a scratch query.` };
    }
  }
  return { ok: true, sql };
}

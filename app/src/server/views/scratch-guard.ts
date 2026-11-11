/**
 * Pre-flight checks for a Scratch query (#306). The database is the real
 * guard (a read-only, always-rolled-back transaction as `authenticated`, a
 * statement timeout, the row cap, and the subquery wrapper that makes a
 * stacked statement a syntax error). These checks only give the common
 * mistakes a clear message BEFORE a round trip, and refuse the few functions
 * a read-only transaction does NOT stop (`set_config` could rewrite
 * `request.jwt.claims` mid-statement, so a scratch query could read AS someone
 * else; the rest run nested SQL text, touch files, sequences or backends, or
 * sleep).
 *
 * The parse-based checks are the views compiler's own `analyzeSqlStep`
 * (@caden/data-core/views), so Scratch and "Save as view" agree on what a
 * query may read and call. Its output-column rules (every column named, no
 * duplicates, `*` only over known tables) shape a VIEW's rows, not a scratch
 * result, so they are not applied here; Save as view reports them.
 */

import { analyzeSqlStep } from "@caden/data-core/views";

const NOT_READ_ONLY =
  "Scratch queries are read-only: write a single SELECT (or WITH … SELECT). Nothing here can change data.";

const WRITE_KEYWORDS =
  /^(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|do|set|reset|vacuum|analyze|lock|listen|notify|begin|start|commit|rollback|savepoint|prepare|execute|explain)\b/i;

/** Output-column rules that only matter once the query becomes a view's step. */
const COLUMN_SHAPE_ERROR = /^(Give every output column|Duplicate output column|Cannot expand \*)/;

/** The analyzer's wording, with the scratch wording for a denied function. */
function scratchMessage(message: string): string {
  return message.replace(
    /^(The function .+\(\)) is not allowed\.$/,
    "$1 is not allowed in a scratch query.",
  );
}

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

/** `inputAliases` are the scratch tables' aliases (the query reads `in_<alias>`). */
export function guardScratchSql(raw: string, inputAliases: readonly string[]): GuardResult {
  const sql = stripTrailingSemicolons(raw);
  const head = withoutLeadingNoise(sql);
  if (head === "") {
    return { ok: false, error: "Write a SELECT query to run." };
  }
  if (WRITE_KEYWORDS.test(head)) {
    return { ok: false, error: NOT_READ_ONLY };
  }
  // A unicode-escaped identifier (U&"set\005fconfig") would slip past the function-name check.
  if (/\bu&\s*["']/i.test(sql)) {
    return {
      ok: false,
      error: 'Unicode-escaped identifiers (U&"…") are not allowed in a scratch query.',
    };
  }
  const analysis = analyzeSqlStep(sql, [...inputAliases]);
  if (analysis.ok) {
    if (analysis.analysis.prevRefs.length > 0) {
      return { ok: false, error: "A scratch query has no previous step; read an in_<table>." };
    }
  } else {
    const error = analysis.errors.find((e) => !COLUMN_SHAPE_ERROR.test(e.message));
    if (error !== undefined) {
      return { ok: false, error: scratchMessage(error.message) };
    }
  }
  return { ok: true, sql };
}

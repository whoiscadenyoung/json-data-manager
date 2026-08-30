/**
 * Parse a data payload that may be either a JSON document (a single array or
 * object) or a JSONL / NDJSON stream (one JSON value per line).
 *
 * Strategy: attempt a whole-file `JSON.parse` first — this handles a JSON array
 * or a (possibly pretty-printed) single object. Only when that fails do we fall
 * back to line-by-line parsing, which is what a genuine JSONL file requires
 * (multiple top-level values make a whole-file parse throw). Per-line parse
 * failures are collected instead of aborting the whole import, so one bad row
 * doesn't discard the rest.
 */
export type ParseError = { line: number; message: string };

export interface ParseDataResult {
  rows: unknown[];
  errors: ParseError[];
}

export function parseDataRows(text: string): ParseDataResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { rows: [], errors: [] };
  }

  // 1. Try to parse the whole thing as a single JSON document.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return { rows: parsed, errors: [] };
    }
    // A single top-level object is treated as a one-row dataset.
    if (typeof parsed === "object" && parsed !== null) {
      return { rows: [parsed], errors: [] };
    }
    // A bare primitive (string/number/boolean/null) isn't a usable row.
    return {
      rows: [],
      errors: [{ line: 1, message: "Expected a JSON array or object of records." }],
    };
  } catch {
    // Fall through to JSONL parsing.
  }

  // 2. Parse as JSONL / NDJSON — one JSON value per non-blank line.
  const rows: unknown[] = [];
  const errors: ParseError[] = [];
  const lines = trimmed.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      errors.push({ line: i + 1, message: "Line is not valid JSON." });
    }
  }

  return { rows, errors };
}

/**
 * RFC 4180-ish CSV parsing: a small hand-rolled state machine rather than a
 * dependency, since a CSV file is one flat sheet and the format is simple
 * enough not to need a library. Handles quoted fields, embedded commas and
 * newlines, and doubled-quote (`""`) escapes. The first row is treated as
 * headers; every other row becomes one object keyed by those headers.
 */
import { readFileAsText } from "./file-utils.js";
import type { ImportParseError, ImportParseResult, ImportParser } from "./types.js";

interface CsvScanState {
  rows: string[][];
  row: string[];
  cell: string;
}

interface CsvScanStep {
  nextIndex: number;
  inQuotes: boolean;
}

/** Advances one character while inside a quoted field: `""` is an escaped quote, any other `"` ends the quote. */
function stepInQuotes(text: string, i: number, state: CsvScanState): CsvScanStep {
  const char = text[i];
  if (char !== '"') {
    state.cell += char;
    return { inQuotes: true, nextIndex: i + 1 };
  }
  if (text[i + 1] === '"') {
    state.cell += '"';
    return { inQuotes: true, nextIndex: i + 2 };
  }
  return { inQuotes: false, nextIndex: i + 1 };
}

/** Advances one character outside any quoted field: `,` ends a cell, `\n` ends a row, `"` opens a quoted field. */
function stepUnquoted(text: string, i: number, state: CsvScanState): CsvScanStep {
  const char = text[i];
  if (char === '"') {
    return { inQuotes: true, nextIndex: i + 1 };
  }
  if (char === ",") {
    state.row.push(state.cell);
    state.cell = "";
  } else if (char === "\n") {
    state.row.push(state.cell);
    state.rows.push(state.row);
    state.row = [];
    state.cell = "";
  } else if (char !== "\r") {
    state.cell += char;
  }
  return { inQuotes: false, nextIndex: i + 1 };
}

/** Splits CSV text into rows of raw string cells, honoring quoting. Never throws. */
function parseCsvCells(text: string): string[][] {
  const state: CsvScanState = { cell: "", row: [], rows: [] };
  let inQuotes = false,
    i = 0;
  const { length } = text;

  while (i < length) {
    const step: CsvScanStep = inQuotes
      ? stepInQuotes(text, i, state)
      : stepUnquoted(text, i, state);
    inQuotes = step.inQuotes;
    i = step.nextIndex;
  }

  // Flush a trailing row that wasn't newline-terminated.
  if (state.cell.length > 0 || state.row.length > 0) {
    state.row.push(state.cell);
    state.rows.push(state.row);
  }

  return state.rows;
}

/** Best-effort coercion of a raw CSV cell string into a JSON-ish value (number/boolean/empty→undefined), so inferred schemas aren't all-string. */
function coerceCsvValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return trimmed;
}

function headerRow(cells: string[]): string[] {
  return cells.map((cell, index) => (cell.trim().length > 0 ? cell.trim() : `column_${index + 1}`));
}

function cellsToRows(cells: string[][]): {
  rows: Record<string, unknown>[];
  errors: ImportParseError[];
} {
  if (cells.length === 0) {
    return { errors: [], rows: [] };
  }
  const [rawHeaderRow, ...dataRows] = cells,
    headers = headerRow(rawHeaderRow),
    errors: ImportParseError[] = [],
    rows: Record<string, unknown>[] = [];

  for (const [index, cellsRow] of dataRows.entries()) {
    // A single empty cell is a blank trailing line (common with a trailing newline) — skip silently.
    if (cellsRow.length === 1 && cellsRow[0].trim() === "") {
      continue;
    }
    if (cellsRow.length !== headers.length) {
      errors.push({
        line: index + 2,
        message: `Row has ${cellsRow.length} column(s), expected ${headers.length}.`,
      });
      continue;
    }
    const obj: Record<string, unknown> = {};
    for (const [colIndex, header] of headers.entries()) {
      obj[header] = coerceCsvValue(cellsRow[colIndex]);
    }
    rows.push(obj);
  }

  return { errors, rows };
}

export function parseCsvText(text: string): ImportParseResult {
  if (text.trim() === "") {
    return { errors: [], sheets: [] };
  }
  const { rows, errors } = cellsToRows(parseCsvCells(text));
  return { errors, sheets: rows.length > 0 ? [{ name: "Sheet1", rows }] : [] };
}

export async function parseCsvFile(file: File): Promise<ImportParseResult> {
  return parseCsvText(await readFileAsText(file));
}

export const csvParser: ImportParser = {
  accept: ".csv,text/csv",
  extensions: [".csv"],
  id: "csv",
  label: "CSV",
  matches: (file) => /\.csv$/i.test(file.name) || file.type === "text/csv",
  parse: parseCsvFile,
};

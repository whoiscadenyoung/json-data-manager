/**
 * Currency-shaped values (issues #291 detection, #292 typing): text like
 * ` $1,492,204 `, `(500.00)`, `-€12.50` or `1.234,56 €` that names a number
 * but imports as a string, so it can't be summed, sorted or aggregated.
 *
 * One implementation for every caller — the import flow's suggestions, the
 * schema editor's "type as currency" action and the views typing — so they
 * agree on what parses. The policy is conservative (the #279 "never silent"
 * posture):
 *
 * - **Accepted:** an optional symbol (`$ € £ ¥`) before or after the
 *   number, surrounding whitespace, a leading `-` (before or after the
 *   symbol) or parentheses for a negative, comma thousands separators in
 *   groups of three, a `.` decimal part. The European form (`.` thousands,
 *   `,` decimals: `1.234,56`) is accepted when both separators appear.
 * - **Refused, not guessed:** a lone `.`-group with a `€` (`€1.234` — 1.234
 *   or 1234?), a lone `,`-group with decimals of three digits after a `.`
 *   elsewhere, malformed groups (`1,23,456`), more than one symbol, letters.
 * - Blank text is reported as `blank`, never as zero.
 */
/** The symbols the parser recognizes. ISO codes (`USD`) are deliberately out of scope. */
export const CURRENCY_SYMBOLS = ["$", "€", "£", "¥"] as const;
export type CurrencySymbol = (typeof CURRENCY_SYMBOLS)[number];

export type CurrencyParse =
  | {
      kind: "number";
      value: number;
      /** The symbol the text carried, or `null` (a bare number, or `1,234`). */
      symbol: CurrencySymbol | null;
      /** True when the text had a currency marker: a symbol, a thousands separator or parentheses. Plain numbers are `false`. */
      marked: boolean;
    }
  | { kind: "blank" }
  | { kind: "invalid"; reason: string };

const US_GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/,
  EU_GROUPED = /^\d{1,3}(?:\.\d{3})+,\d+$/,
  PLAIN = /^\d+(?:\.\d+)?$/,
  AMBIGUOUS_DOT_GROUP = /^\d{1,3}\.\d{3}$/;

function isSymbol(char: string): char is CurrencySymbol {
  return (CURRENCY_SYMBOLS as readonly string[]).includes(char);
}

interface Stripped {
  body: string;
  negative: boolean;
  symbols: CurrencySymbol[];
  parens: boolean;
}

/** Peels parentheses, signs and symbols off both ends, in any order. */
function strip(text: string): Stripped {
  let body = text.trim(),
    negative = false,
    parens = false;
  const symbols: CurrencySymbol[] = [];
  if (body.startsWith("(") && body.endsWith(")")) {
    parens = true;
    negative = true;
    body = body.slice(1, -1).trim();
  }
  for (let guard = 0; guard < 4; guard += 1) {
    const first = body.charAt(0),
      last = body.charAt(body.length - 1);
    if (first === "-" && !negative) {
      negative = true;
      body = body.slice(1).trim();
    } else if (isSymbol(first)) {
      symbols.push(first);
      body = body.slice(1).trim();
    } else if (isSymbol(last)) {
      symbols.push(last);
      body = body.slice(0, -1).trim();
    } else {
      break;
    }
  }
  return { body, negative, parens, symbols };
}

/** The magnitude `body` names, or why it doesn't name one. */
function magnitudeOf(
  body: string,
  symbol: CurrencySymbol | null,
): { value: number; grouped: boolean } | { reason: string } {
  if (US_GROUPED.test(body)) {
    return { grouped: true, value: Number(body.replaceAll(",", "")) };
  }
  if (EU_GROUPED.test(body)) {
    return { grouped: true, value: Number(body.replaceAll(".", "").replace(",", ".")) };
  }
  if (symbol === "€" && AMBIGUOUS_DOT_GROUP.test(body)) {
    return { reason: `"${body}" could be a decimal or a thousands group` };
  }
  if (PLAIN.test(body)) {
    return { grouped: false, value: Number(body) };
  }
  return { reason: `"${body}" is not a number` };
}

/** A non-text, non-number cell: null/undefined are blank, everything else is refused. */
function parseNonText(value: unknown): CurrencyParse {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", marked: false, symbol: null, value }
      : { kind: "invalid", reason: "not a finite number" };
  }
  return value === null || value === undefined
    ? { kind: "blank" }
    : { kind: "invalid", reason: "not text or a number" };
}

/** Reads one non-blank text cell. */
function parseText(text: string): CurrencyParse {
  const stripped = strip(text);
  if (stripped.symbols.length > 1) {
    return { kind: "invalid", reason: "more than one currency symbol" };
  }
  const symbol = stripped.symbols.length === 1 ? stripped.symbols[0] : null,
    magnitude = magnitudeOf(stripped.body, symbol);
  if ("reason" in magnitude) {
    return { kind: "invalid", reason: magnitude.reason };
  }
  if (!Number.isFinite(magnitude.value)) {
    return { kind: "invalid", reason: "out of range" };
  }
  const signed = stripped.negative ? -magnitude.value : magnitude.value;
  return {
    kind: "number",
    marked: symbol !== null || magnitude.grouped || stripped.parens,
    symbol,
    // `-0` reads as 0 everywhere a user would look.
    value: signed === 0 ? 0 : signed,
  };
}

/** Reads one cell as a currency amount. Numbers pass through unmarked; blank text and null are `blank`. */
export function parseCurrencyValue(value: unknown): CurrencyParse {
  if (typeof value !== "string") {
    return parseNonText(value);
  }
  return value.trim() === "" ? { kind: "blank" } : parseText(value);
}

export interface CurrencyColumnGuess {
  field: string;
  /** The one symbol the sampled values used, or `null` when none carried one (`1,234` thousands only). */
  symbol: CurrencySymbol | null;
  /** True when sampled values used different symbols — a typing action must refuse rather than guess. */
  mixedSymbols: boolean;
  /** Non-blank values sampled. */
  sampled: number;
  /** Of those, how many parsed. */
  parsed: number;
}

export interface CurrencyDetectOptions {
  /** Rows sampled, evenly spread over the input (default 200). */
  sampleSize?: number;
  /** Fraction of non-blank sampled values that must parse (default 0.9). */
  minRatio?: number;
}

function sampleEvenly<T>(items: readonly T[], sampleSize: number): T[] {
  if (items.length <= sampleSize) {
    return [...items];
  }
  const step = items.length / sampleSize,
    sample: T[] = [];
  for (let i = 0; i < sampleSize; i += 1) {
    sample.push(items[Math.floor(i * step)]);
  }
  return sample;
}

function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return [...seen];
}

interface ColumnTally {
  sampled: number;
  parsed: number;
  markedText: number;
  symbols: Set<CurrencySymbol>;
}

function tallyColumn(rows: readonly Record<string, unknown>[], field: string): ColumnTally {
  const tally: ColumnTally = { markedText: 0, parsed: 0, sampled: 0, symbols: new Set() };
  for (const row of rows) {
    const parsed = parseCurrencyValue(row[field]);
    if (parsed.kind === "blank") {
      continue;
    }
    tally.sampled += 1;
    if (parsed.kind !== "number") {
      continue;
    }
    tally.parsed += 1;
    if (parsed.marked && typeof row[field] === "string") {
      tally.markedText += 1;
    }
    if (parsed.symbol !== null) {
      tally.symbols.add(parsed.symbol);
    }
  }
  return tally;
}

/**
 * Columns of plain row data whose values look like currency amounts stored
 * as text: at least `minRatio` of the non-blank sampled values parse, and at
 * least one of them is TEXT carrying a marker (a symbol, a thousands
 * separator or parentheses). A column of real numbers, or of plain decimal
 * strings, is not suggested — the schema inference already types those.
 */
export function detectCurrencyColumns(
  rows: readonly Record<string, unknown>[],
  options: CurrencyDetectOptions = {},
): CurrencyColumnGuess[] {
  const sample = sampleEvenly(rows, options.sampleSize ?? 200),
    minRatio = options.minRatio ?? 0.9,
    guesses: CurrencyColumnGuess[] = [];
  for (const field of columnsOf(sample)) {
    const tally = tallyColumn(sample, field);
    if (tally.sampled === 0 || tally.markedText === 0 || tally.parsed / tally.sampled < minRatio) {
      continue;
    }
    const symbols = [...tally.symbols];
    guesses.push({
      field,
      mixedSymbols: symbols.length > 1,
      parsed: tally.parsed,
      sampled: tally.sampled,
      symbol: symbols.length === 1 ? symbols[0] : null,
    });
  }
  return guesses;
}

export interface CurrencyConversionFailure {
  /** Index of the row in the input. */
  index: number;
  value: unknown;
  reason: string;
}

export interface CurrencyConversion<T> {
  /** The rows with `field` rewritten: parsed values become numbers, blank text is removed. Rows that failed keep their original value. */
  rows: T[];
  converted: number;
  blanks: number;
  failures: CurrencyConversionFailure[];
}

/**
 * Rewrites `field` across `rows` through `parseCurrencyValue` — the stored
 * rewrite behind "type as number". Pure: returns new row objects and leaves
 * the input untouched. Callers show `failures` before applying and must not
 * type the column while any remain (failed rows keep their text).
 */
export function convertCurrencyColumn<T extends Record<string, unknown>>(
  rows: readonly T[],
  field: string,
): CurrencyConversion<T> {
  const out: T[] = [],
    failures: CurrencyConversionFailure[] = [];
  let converted = 0,
    blanks = 0;
  for (const [index, row] of rows.entries()) {
    if (!(field in row)) {
      out.push(row);
      continue;
    }
    const parsed = parseCurrencyValue(row[field]);
    if (parsed.kind === "number") {
      converted += 1;
      out.push({ ...row, [field]: parsed.value });
    } else if (parsed.kind === "blank") {
      blanks += 1;
      const { [field]: _removed, ...rest } = row;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dropping one key keeps the row's record shape.
      out.push(rest as T);
    } else {
      failures.push({ index, reason: parsed.reason, value: row[field] });
      out.push(row);
    }
  }
  return { blanks, converted, failures, rows: out };
}

/**
 * The custom JSON Schema keyword a currency column carries (issue #292): a
 * `number` property annotated `"x-currency": "$"` (or `""` for amounts with
 * no symbol). Like `x-reference`, validators ignore it; it is a DISPLAY hint
 * only — values are stored and exported as plain numbers.
 */
export const CURRENCY_KEYWORD = "x-currency";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level properties annotated with `x-currency`, mapped to their symbol (`""` = no symbol). */
export function currencyFieldsOf(schema: unknown): Record<string, string> {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return {};
  }
  const fields: Record<string, string> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    if (isRecord(property) && typeof property[CURRENCY_KEYWORD] === "string") {
      fields[name] = property[CURRENCY_KEYWORD];
    }
  }
  return fields;
}

/**
 * `1234.5` with `"$"` → `$1,234.50`; negatives as `-$1,234.50`. Two decimals
 * unless the amount has more (never rounds data away). Non-numbers are
 * returned as their string form.
 */
export function formatCurrency(value: unknown, symbol: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (value === null || value === undefined) {
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  const decimals = (String(value).split(".")[1] ?? "").length,
    digits = Math.abs(value).toLocaleString("en-US", {
      maximumFractionDigits: Math.max(2, decimals),
      minimumFractionDigits: 2,
    });
  return `${value < 0 ? "-" : ""}${symbol}${digits}`;
}

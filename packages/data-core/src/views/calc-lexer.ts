import { ExpressionError } from "./calc-ast.js";

export type TokenKind = "number" | "string" | "ident" | "quoted" | "op" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  /** Source text for idents / ops / punctuation; the decoded text for strings and quoted names. */
  text: string;
  start: number;
  end: number;
}

const OPERATORS = ["<=", ">=", "<>", "!=", "==", "+", "-", "*", "/", "=", "<", ">"];
const PUNCTUATION = new Set(["(", ")", ","]);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function scanDigits(src: string, from: number): number {
  let i = from;
  while (i < src.length && DIGIT.test(src.charAt(i))) {
    i += 1;
  }
  return i;
}

function scanNumber(src: string, start: number): Token {
  let i = scanDigits(src, start);
  if (src.charAt(i) === "." && DIGIT.test(src.charAt(i + 1))) {
    i = scanDigits(src, i + 1);
  }
  if (IDENT_START.test(src.charAt(i))) {
    throw new ExpressionError("A number cannot be followed by letters.", { start, end: i + 1 });
  }
  return { kind: "number", text: src.slice(start, i), start, end: i };
}

/**
 * Scan a quoted run. `'...'` is a string literal, `"..."` a field name; a
 * doubled quote is a literal quote character in both.
 */
function scanQuoted(src: string, start: number, quote: "'" | '"'): Token {
  let i = start + 1;
  let text = "";
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch !== quote) {
      text += ch;
      i += 1;
    } else if (src.charAt(i + 1) === quote) {
      text += quote;
      i += 2;
    } else {
      return { kind: quote === "'" ? "string" : "quoted", text, start, end: i + 1 };
    }
  }
  const what = quote === "'" ? "string" : "quoted field name";
  throw new ExpressionError(`Unterminated ${what}.`, { start, end: src.length });
}

function scanWord(src: string, start: number): Token {
  let i = start + 1;
  while (i < src.length && IDENT_PART.test(src.charAt(i))) {
    i += 1;
  }
  return { kind: "ident", text: src.slice(start, i), start, end: i };
}

function scanOperator(src: string, start: number): Token | undefined {
  const op = OPERATORS.find((candidate) => src.startsWith(candidate, start));
  return op === undefined ? undefined : { kind: "op", text: op, start, end: start + op.length };
}

function scanToken(src: string, start: number): Token {
  const ch = src.charAt(start);
  if (DIGIT.test(ch)) {
    return scanNumber(src, start);
  }
  if (ch === "'" || ch === '"') {
    return scanQuoted(src, start, ch);
  }
  if (IDENT_START.test(ch)) {
    return scanWord(src, start);
  }
  if (PUNCTUATION.has(ch)) {
    return { kind: "punct", text: ch, start, end: start + 1 };
  }
  const op = scanOperator(src, start);
  if (op !== undefined) {
    return op;
  }
  throw new ExpressionError(`Unexpected character "${ch}".`, { start, end: start + 1 });
}

/** Split an expression into tokens (ending with an `eof` token). */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src.charAt(i))) {
      i += 1;
    } else {
      const token = scanToken(src, i);
      tokens.push(token);
      i = token.end;
    }
  }
  tokens.push({ kind: "eof", text: "", start: src.length, end: src.length });
  return tokens;
}

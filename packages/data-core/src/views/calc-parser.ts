/**
 * Pratt parser for the `calculate` expression language. Precedence, low to
 * high: `or`, `and`, `not`, comparisons / `is null`, `+ -`, `* /`, unary
 * minus. Comparison and arithmetic operators are left-associative.
 */

import { ExpressionError } from "./calc-ast.js";
import type { BinaryOp, ExprDiagnostic, ExprNode, ParseResult } from "./calc-ast.js";
import { tokenize } from "./calc-lexer.js";
import type { Token } from "./calc-lexer.js";

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "true",
  "false",
  "case",
  "when",
  "then",
  "else",
  "end",
]);

const BP_OR = 1;
const BP_AND = 2;
const BP_NOT = 3;
const BP_COMPARE = 4;
const BP_ADD = 5;
const BP_MUL = 6;
const BP_NEGATE = 7;

const INFIX: Record<string, { bp: number; op: BinaryOp }> = {
  or: { bp: BP_OR, op: "or" },
  and: { bp: BP_AND, op: "and" },
  "=": { bp: BP_COMPARE, op: "=" },
  "==": { bp: BP_COMPARE, op: "=" },
  "!=": { bp: BP_COMPARE, op: "!=" },
  "<>": { bp: BP_COMPARE, op: "!=" },
  "<": { bp: BP_COMPARE, op: "<" },
  "<=": { bp: BP_COMPARE, op: "<=" },
  ">": { bp: BP_COMPARE, op: ">" },
  ">=": { bp: BP_COMPARE, op: ">=" },
  "+": { bp: BP_ADD, op: "+" },
  "-": { bp: BP_ADD, op: "-" },
  "*": { bp: BP_MUL, op: "*" },
  "/": { bp: BP_MUL, op: "/" },
};

function describe(token: Token): string {
  return token.kind === "eof" ? "the end of the expression" : `"${token.text}"`;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token.kind !== "eof") {
      this.pos += 1;
    }
    return token;
  }

  private isWord(token: Token, word: string): boolean {
    return token.kind === "ident" && token.text.toLowerCase() === word;
  }

  private isPunct(token: Token, text: string): boolean {
    return token.kind === "punct" && token.text === text;
  }

  private expectPunct(text: string): Token {
    const token = this.peek();
    if (!this.isPunct(token, text)) {
      throw new ExpressionError(`Expected "${text}" but found ${describe(token)}.`, token);
    }
    return this.next();
  }

  private expectWord(word: string): Token {
    const token = this.peek();
    if (!this.isWord(token, word)) {
      throw new ExpressionError(`Expected "${word}" but found ${describe(token)}.`, token);
    }
    return this.next();
  }

  parseAll(): ExprNode {
    const first = this.peek();
    if (first.kind === "eof") {
      throw new ExpressionError("The expression is empty.", first);
    }
    const node = this.expression(0);
    const rest = this.peek();
    if (rest.kind !== "eof") {
      throw new ExpressionError(
        this.isPunct(rest, ")")
          ? 'Unbalanced parentheses: this ")" has no matching "(".'
          : `Unexpected ${describe(rest)}.`,
        rest,
      );
    }
    return node;
  }

  private infixOf(token: Token): { bp: number; op: BinaryOp } | undefined {
    if (token.kind === "op") {
      return INFIX[token.text];
    }
    if (token.kind === "ident") {
      const word = token.text.toLowerCase();
      return word === "and" || word === "or" ? INFIX[word] : undefined;
    }
    return undefined;
  }

  private expression(minBp: number): ExprNode {
    let left = this.prefix();
    for (;;) {
      const token = this.peek();
      if (this.isWord(token, "is") && BP_COMPARE >= minBp) {
        left = this.isNull(left);
        continue;
      }
      const infix = this.infixOf(token);
      if (infix === undefined || infix.bp < minBp) {
        return left;
      }
      this.next();
      const right = this.expression(infix.bp + 1);
      left = { type: "binary", op: infix.op, left, right, start: left.start, end: right.end };
    }
  }

  private isNull(operand: ExprNode): ExprNode {
    this.next();
    const negated = this.isWord(this.peek(), "not");
    if (negated) {
      this.next();
    }
    const last = this.expectWord("null");
    return { type: "isNull", negated, operand, start: operand.start, end: last.end };
  }

  private prefix(): ExprNode {
    const token = this.peek();
    if (token.kind === "op" && token.text === "-") {
      this.next();
      const operand = this.expression(BP_NEGATE);
      return { type: "unary", op: "-", operand, start: token.start, end: operand.end };
    }
    if (this.isWord(token, "not")) {
      this.next();
      const operand = this.expression(BP_NOT);
      return { type: "unary", op: "not", operand, start: token.start, end: operand.end };
    }
    return this.primary();
  }

  private primary(): ExprNode {
    const token = this.next();
    const span = { start: token.start, end: token.end };
    switch (token.kind) {
      case "number":
        return { type: "number", value: Number(token.text), ...span };
      case "string":
        return { type: "string", value: token.text, ...span };
      case "quoted":
        return { type: "field", name: token.text, ...span };
      case "ident":
        return this.word(token);
      case "punct":
        return this.parenthesized(token);
      default:
        throw new ExpressionError(
          token.kind === "eof"
            ? "The expression ends unexpectedly."
            : `Unexpected ${describe(token)}.`,
          token,
        );
    }
  }

  private parenthesized(open: Token): ExprNode {
    if (open.text !== "(") {
      throw new ExpressionError(`Unexpected ${describe(open)}.`, open);
    }
    const inner = this.expression(0);
    const close = this.peek();
    if (!this.isPunct(close, ")")) {
      throw new ExpressionError(
        `Unbalanced parentheses: this "(" is never closed (found ${describe(close)}).`,
        open,
      );
    }
    this.next();
    return { ...inner, start: open.start, end: close.end };
  }

  private word(token: Token): ExprNode {
    const lower = token.text.toLowerCase();
    const span = { start: token.start, end: token.end };
    if (lower === "true" || lower === "false") {
      return { type: "boolean", value: lower === "true", ...span };
    }
    if (lower === "null") {
      return { type: "null", ...span };
    }
    if (lower === "case") {
      return this.caseExpression(token);
    }
    if (KEYWORDS.has(lower)) {
      throw new ExpressionError(
        `"${token.text}" is a reserved word here; quote it ("${token.text}") to use it as a field name.`,
        token,
      );
    }
    if (this.isPunct(this.peek(), "(")) {
      return this.call(token, lower);
    }
    return { type: "field", name: token.text, ...span };
  }

  private call(nameToken: Token, name: string): ExprNode {
    this.next();
    const args: ExprNode[] = [];
    if (!this.isPunct(this.peek(), ")")) {
      args.push(this.expression(0));
      while (this.isPunct(this.peek(), ",")) {
        this.next();
        args.push(this.expression(0));
      }
    }
    const close = this.peek();
    if (!this.isPunct(close, ")")) {
      throw new ExpressionError(
        `Unbalanced parentheses: the call to ${name}( is never closed (found ${describe(close)}).`,
        nameToken,
      );
    }
    this.next();
    return { type: "call", name, args, start: nameToken.start, end: close.end };
  }

  private caseExpression(start: Token): ExprNode {
    const branches: { when: ExprNode; result: ExprNode }[] = [];
    while (this.isWord(this.peek(), "when")) {
      this.next();
      const when = this.expression(0);
      this.expectWord("then");
      branches.push({ when, result: this.expression(0) });
    }
    if (branches.length === 0) {
      throw new ExpressionError('A case needs at least one "when ... then ...".', this.peek());
    }
    let otherwise: ExprNode | undefined;
    if (this.isWord(this.peek(), "else")) {
      this.next();
      otherwise = this.expression(0);
    }
    const end = this.expectWord("end");
    return { type: "case", branches, otherwise, start: start.start, end: end.end };
  }
}

/** Parse an expression. Never throws: errors come back as located diagnostics. */
export function parseExpression(src: string): ParseResult {
  try {
    return { ok: true, ast: new Parser(tokenize(src)).parseAll() };
  } catch (error) {
    if (error instanceof ExpressionError) {
      const diagnostic: ExprDiagnostic = {
        message: error.message,
        start: error.start,
        end: error.end,
      };
      return { ok: false, errors: [diagnostic] };
    }
    throw error;
  }
}

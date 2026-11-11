/**
 * The `calculate` expression language (docs/views-design.md §4): AST types
 * and the error shape shared by the lexer, parser and SQL compiler. Every
 * node carries its source offsets so errors can point at the exact text.
 */

export interface SourceSpan {
  /** Offset of the first character (inclusive). */
  start: number;
  /** Offset after the last character (exclusive). */
  end: number;
}

export type BinaryOp = "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type ExprNode = SourceSpan &
  (
    | { type: "number"; value: number }
    | { type: "string"; value: string }
    | { type: "boolean"; value: boolean }
    | { type: "null" }
    | { type: "field"; name: string }
    | { type: "unary"; op: "-" | "not"; operand: ExprNode }
    | { type: "binary"; op: BinaryOp; left: ExprNode; right: ExprNode }
    | { type: "isNull"; negated: boolean; operand: ExprNode }
    | { type: "call"; name: string; args: ExprNode[] }
    | { type: "case"; branches: { when: ExprNode; result: ExprNode }[]; otherwise?: ExprNode }
  );

/** A problem in an expression, located by source offsets. */
export interface ExprDiagnostic extends SourceSpan {
  message: string;
}

/** Thrown inside the expression pipeline; callers convert it to a diagnostic. */
export class ExpressionError extends Error implements ExprDiagnostic {
  readonly start: number;
  readonly end: number;

  constructor(message: string, span: SourceSpan) {
    super(message);
    this.name = "ExpressionError";
    this.start = span.start;
    this.end = span.end;
  }
}

export type ParseResult = { ok: true; ast: ExprNode } | { ok: false; errors: ExprDiagnostic[] };

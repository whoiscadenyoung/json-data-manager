import { describe, expect, test } from "vitest";

import type { ExprNode } from "./calc-ast.js";
import { parseExpression } from "./calc-parser.js";
import { EXPRESSION_FUNCTIONS } from "./calc-sql.js";
import { analyzeExpression, expressionFieldRefs } from "./calculate.js";
import type { FieldType } from "./types.js";

function showCase(node: Extract<ExprNode, { type: "case" }>): string {
  const branches = node.branches.map((b) => `[${show(b.when)} ${show(b.result)}]`).join("");
  const tail = node.otherwise === undefined ? "" : ` else ${show(node.otherwise)}`;
  return `(case ${branches}${tail})`;
}

function isNullLabel(negated: boolean): string {
  return negated ? "not-null" : "null";
}

function showLeaf(node: ExprNode): string {
  switch (node.type) {
    case "string":
      return JSON.stringify(node.value);
    case "field":
      return `$${node.name}`;
    case "null":
      return "null";
    default:
      return "value" in node ? String(node.value) : "?";
  }
}

/** Render an AST as an s-expression so precedence is easy to assert. */
function show(node: ExprNode): string {
  switch (node.type) {
    case "number":
    case "boolean":
    case "string":
    case "null":
    case "field":
      return showLeaf(node);
    case "unary":
      return `(${node.op} ${show(node.operand)})`;
    case "binary":
      return `(${node.op} ${show(node.left)} ${show(node.right)})`;
    case "isNull":
      return `(is-${isNullLabel(node.negated)} ${show(node.operand)})`;
    case "call":
      return `(${node.name}${node.args.map((arg) => ` ${show(arg)}`).join("")})`;
    default:
      return showCase(node);
  }
}

function parsed(src: string): string {
  const result = parseExpression(src);
  if (!result.ok) {
    throw new Error(`parse failed: ${result.errors[0].message}`);
  }
  return show(result.ast);
}

function errorOf(src: string, fields?: Record<string, FieldType>) {
  const result =
    fields === undefined ? parseExpression(src) : analyzeExpression(src, (name) => fields[name]);
  if (result.ok) {
    throw new Error(`expected an error for: ${src}`);
  }
  return result.errors[0];
}

describe("parseExpression: precedence and shape", () => {
  test("* and / bind tighter than + and -", () => {
    expect(parsed("1 + 2 * 3")).toBe("(+ 1 (* 2 3))");
    expect(parsed("1 * 2 + 3")).toBe("(+ (* 1 2) 3)");
    expect(parsed("8 / 2 / 2")).toBe("(/ (/ 8 2) 2)");
    expect(parsed("10 - 4 - 3")).toBe("(- (- 10 4) 3)");
  });

  test("parentheses override precedence", () => {
    expect(parsed("(1 + 2) * 3")).toBe("(* (+ 1 2) 3)");
  });

  test("unary minus binds tighter than multiplication", () => {
    expect(parsed("-a * b")).toBe("(* (- $a) $b)");
    expect(parsed("2 - -3")).toBe("(- 2 (- 3))");
  });

  test("comparison binds looser than arithmetic, and/or looser still", () => {
    expect(parsed("a + 1 > b * 2")).toBe("(> (+ $a 1) (* $b 2))");
    expect(parsed("a = 1 or b = 2 and c = 3")).toBe("(or (= $a 1) (and (= $b 2) (= $c 3)))");
  });

  test("not covers a whole comparison", () => {
    expect(parsed("not a = 1 and b")).toBe("(and (not (= $a 1)) $b)");
    expect(parsed("not (a or b)")).toBe("(not (or $a $b))");
  });

  test("comparison operator spellings normalize", () => {
    expect(parsed("a == 1")).toBe("(= $a 1)");
    expect(parsed("a <> 1")).toBe("(!= $a 1)");
    expect(parsed("a != 1")).toBe("(!= $a 1)");
    expect(parsed("a <= 1")).toBe("(<= $a 1)");
  });

  test("is null / is not null", () => {
    expect(parsed("a is null")).toBe("(is-null $a)");
    expect(parsed("a + 1 is not null and b")).toBe("(and (is-not-null (+ $a 1)) $b)");
  });

  test("calls, case, if and literals", () => {
    expect(parsed("coalesce(a, 'x', 0)")).toBe('(coalesce $a "x" 0)');
    expect(parsed("IF(a > 1, 'big', 'small')")).toBe('(if (> $a 1) "big" "small")');
    expect(parsed("round(1.25, 1)")).toBe("(round 1.25 1)");
    expect(parsed("case when a then 1 when b then 2 else 3 end")).toBe(
      "(case [$a 1][$b 2] else 3)",
    );
    expect(parsed("true and not false or null")).toBe("(or (and true (not false)) null)");
  });

  test("quoted names allow spaces and dots; doubled quotes escape", () => {
    expect(parsed('"state name" + "deployments.count"')).toBe("(+ $state name $deployments.count)");
    expect(parsed(`'it''s'`)).toBe('"it\'s"');
    expect(parsed('"a ""b"" c"')).toBe('$a "b" c');
  });

  test("nodes carry source offsets", () => {
    const result = parseExpression("a + foo(1)");
    const ast = result.ok ? result.ast : undefined;
    expect(ast).toMatchObject({ type: "binary", right: { type: "call", start: 4, end: 10 } });
  });
});

describe("parseExpression: errors carry a position", () => {
  test("unbalanced parentheses", () => {
    expect(errorOf("(1 + 2")).toMatchObject({ start: 0, end: 1 });
    expect(errorOf("(1 + 2").message).toContain("never closed");
    expect(errorOf("1 + 2)")).toMatchObject({ start: 5, end: 6 });
    expect(errorOf("1 + 2)").message).toContain("no matching");
    expect(errorOf("round(1, 2").message).toContain("round(");
  });

  test("trailing operator, empty input and stray tokens", () => {
    expect(errorOf("1 +")).toMatchObject({ start: 3, end: 3 });
    expect(errorOf("   ").message).toContain("empty");
    expect(errorOf("1 2").message).toContain('Unexpected "2"');
  });

  test("lexical errors", () => {
    expect(errorOf("'abc")).toMatchObject({ start: 0, end: 4 });
    expect(errorOf('"abc').message).toContain("Unterminated");
    expect(errorOf("1 # 2")).toMatchObject({ start: 2, end: 3 });
    expect(errorOf("12ab").message).toContain("number");
  });

  test("reserved words need quoting to be field names; case needs a branch", () => {
    expect(errorOf("end + 1").message).toContain("reserved");
    expect(errorOf("case else 1 end").message).toContain("when");
    expect(errorOf("case when a then 1").message).toContain('"end"');
  });
});

describe("analyzeExpression: functions, arity and types", () => {
  const fields: Record<string, FieldType> = {
    n: "number",
    s: "string",
    b: "boolean",
    u: "unknown",
    d: "date",
  };

  test("an unknown function is rejected with its position", () => {
    const error = errorOf("1 + pg_sleep(10)", fields);
    expect(error.message).toContain('Unknown function "pg_sleep"');
    expect(error).toMatchObject({ start: 4, end: 16 });
  });

  test("the allowlist is closed and documented", () => {
    const names = EXPRESSION_FUNCTIONS.map((fn) => fn.name).toSorted();
    expect(names).toEqual(
      [
        "coalesce",
        "concat",
        "day",
        "if",
        "lower",
        "month",
        "round",
        "trim",
        "upper",
        "year",
      ].toSorted(),
    );
    for (const fn of EXPRESSION_FUNCTIONS) {
      expect(analyzeExpression(`${fn.name}()`, () => "unknown").ok).toBe(false);
    }
  });

  test("arity", () => {
    expect(errorOf("lower()", fields).message).toContain("exactly 1");
    expect(errorOf("round(1, 2, 3)", fields).message).toContain("1 to 2");
    expect(errorOf("coalesce()", fields).message).toContain("at least 1");
    expect(errorOf("if(b, 1)", fields).message).toContain("exactly 3");
  });

  test("unknown field", () => {
    expect(errorOf("n + nope", fields)).toMatchObject({
      message: 'Unknown field "nope".',
      start: 4,
      end: 8,
    });
  });

  test("type errors point at the offending operand", () => {
    expect(errorOf("b * 2", fields).message).toBe("Expected a number but this is boolean.");
    expect(errorOf("b * 2", fields)).toMatchObject({ start: 0, end: 1 });
    expect(errorOf("n = s", fields).message).toContain("different types");
    expect(errorOf("if(n, 1, 2)", fields)).toMatchObject({ start: 3, end: 4 });
    expect(errorOf("case when n > 1 then 'a' else 2 end", fields).message).toContain(
      "different types",
    );
  });

  test("result types", () => {
    const type = (src: string): string => {
      const result = analyzeExpression(src, (name) => fields[name]);
      return result.ok ? result.type : "error";
    };
    expect(type("n * 2")).toBe("number");
    expect(type("lower(s)")).toBe("string");
    expect(type("n > 1 and not b")).toBe("boolean");
    expect(type("coalesce(u, 0)")).toBe("number");
    expect(type("coalesce(u, u)")).toBe("unknown");
    expect(type("year(d)")).toBe("number");
    expect(type("if(b, 'a', 'b')")).toBe("string");
    expect(type("null")).toBe("unknown");
  });

  test("unknown-typed fields are coerced where used", () => {
    expect(analyzeExpression("u + 1", (name) => fields[name]).ok).toBe(true);
    expect(analyzeExpression("lower(u)", (name) => fields[name]).ok).toBe(true);
    expect(analyzeExpression("u and b", (name) => fields[name]).ok).toBe(true);
  });

  test("expressionFieldRefs lists every referenced field once", () => {
    const result = parseExpression('n + coalesce(s, "a b") * n and case when b then u end');
    expect(result.ok && expressionFieldRefs(result.ast).toSorted()).toEqual(
      ["a b", "b", "n", "s", "u"].toSorted(),
    );
  });
});

import { describe, expect, it } from "vitest";

import { coerceNumber, normalizeKey, normalizeText } from "./coercion.js";

describe("normalizeText", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeText("  Grant ID-42\t")).toStrictEqual("grant id-42");
  });

  it("passes an already-normalized string through unchanged", () => {
    expect(normalizeText("grant id-42")).toStrictEqual("grant id-42");
  });

  it("is idempotent", () => {
    const once = normalizeText("  Mixed CASE value ");
    expect(normalizeText(once)).toStrictEqual(once);
  });
});

describe("coerceNumber", () => {
  it("passes a finite number through unchanged", () => {
    expect(coerceNumber(42)).toStrictEqual(42);
    expect(coerceNumber(-3.5)).toStrictEqual(-3.5);
  });

  it("coerces a numeric string, trimmed", () => {
    expect(coerceNumber("42")).toStrictEqual(42);
    expect(coerceNumber("  3.5  ")).toStrictEqual(3.5);
  });

  it("returns undefined for a non-numeric, empty, or whitespace-only string", () => {
    expect(coerceNumber("abc")).toBeUndefined();
    expect(coerceNumber("")).toBeUndefined();
    expect(coerceNumber("   ")).toBeUndefined();
  });

  it("returns undefined for non-finite numbers", () => {
    expect(coerceNumber(Number.NaN)).toBeUndefined();
    expect(coerceNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(coerceNumber(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("refuses booleans, null, undefined, and non-primitives instead of coercing them", () => {
    expect(coerceNumber(true)).toBeUndefined();
    expect(coerceNumber(false)).toBeUndefined();
    expect(coerceNumber(null)).toBeUndefined();
    expect(coerceNumber(undefined)).toBeUndefined();
    // `Number([]) === 0` and `Number([42]) === 42` — exactly the accident this refuses.
    expect(coerceNumber([])).toBeUndefined();
    expect(coerceNumber([42])).toBeUndefined();
    expect(coerceNumber({})).toBeUndefined();
  });

  it("is idempotent, including on a parsed string", () => {
    const once = coerceNumber(" 42.5 ");
    expect(coerceNumber(once)).toStrictEqual(once);
  });
});

describe("normalizeKey", () => {
  it("gives a number and the same numeric string one key — the GrantId case", () => {
    expect(normalizeKey(42)).toStrictEqual("42");
    expect(normalizeKey("42")).toStrictEqual("42");
    expect(normalizeKey(42)).toStrictEqual(normalizeKey("  42 "));
  });

  it("trims and case-folds string keys", () => {
    expect(normalizeKey("ABC-123")).toStrictEqual("abc-123");
    expect(normalizeKey("ABC-123")).toStrictEqual(normalizeKey("  abc-123 "));
  });

  it("renders non-integer numbers in canonical decimal form", () => {
    expect(normalizeKey(3.5)).toStrictEqual("3.5");
    expect(normalizeKey(3.5)).toStrictEqual(normalizeKey("3.5"));
    expect(normalizeKey(-0)).toStrictEqual(normalizeKey("0"));
  });

  it("never numeric-normalizes a string, so zero-padded ids stay distinct", () => {
    expect(normalizeKey("007")).toStrictEqual("007");
    expect(normalizeKey("007")).not.toStrictEqual(normalizeKey(7));
  });

  it("leaves float-notation splits unmatched rather than re-reading strings through Number()", () => {
    // Number 1e21 renders as "1e+21"; the string "1e21" stays "1e21" — a
    // documented missed match, surfaced as unmatched rows, never a wrong join.
    expect(normalizeKey(1e21)).toStrictEqual("1e+21");
    expect(normalizeKey("1e21")).toStrictEqual("1e21");
    expect(normalizeKey(1e21)).not.toStrictEqual(normalizeKey("1e21"));
  });

  it("returns undefined for whitespace-only strings", () => {
    expect(normalizeKey("")).toBeUndefined();
    expect(normalizeKey("   ")).toBeUndefined();
  });

  it("returns undefined for non-finite numbers", () => {
    expect(normalizeKey(Number.NaN)).toBeUndefined();
    expect(normalizeKey(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("returns undefined for values that are neither string nor number", () => {
    expect(normalizeKey(true)).toBeUndefined();
    expect(normalizeKey(null)).toBeUndefined();
    expect(normalizeKey(undefined)).toBeUndefined();
    expect(normalizeKey([])).toBeUndefined();
    expect(normalizeKey({})).toBeUndefined();
  });

  it("passes an already-normalized key through unchanged", () => {
    expect(normalizeKey("grant-42")).toStrictEqual("grant-42");
  });

  it("is idempotent over string, number, and keyless inputs", () => {
    const values: unknown[] = [" 42 ", 42, "Grant ID", 3.5, "007", "", true, null, undefined];
    for (const value of values) {
      const once = normalizeKey(value);
      expect(normalizeKey(once)).toStrictEqual(once);
    }
  });

  it("joins the same GrantId across a number-typed and a string-typed file", () => {
    const numberTyped = [42, 43, 44],
      stringTyped = [" 42 ", "43", "44 "],
      keysOfNumberTyped = numberTyped.map((id) => normalizeKey(id)),
      keysOfStringTyped = stringTyped.map((id) => normalizeKey(id));
    expect(keysOfNumberTyped).toStrictEqual(["42", "43", "44"]);
    for (const key of keysOfStringTyped) {
      expect(keysOfNumberTyped).toContain(key);
    }
  });
});

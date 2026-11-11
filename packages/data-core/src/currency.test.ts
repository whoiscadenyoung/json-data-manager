import { describe, expect, it } from "vitest";

import { convertCurrencyColumn, detectCurrencyColumns, parseCurrencyValue } from "./currency.js";

function marked(text: string): boolean {
  const parsed = parseCurrencyValue(text);
  return parsed.kind === "number" && parsed.marked;
}

function numberOf(value: unknown): number | undefined {
  const parsed = parseCurrencyValue(value);
  return parsed.kind === "number" ? parsed.value : undefined;
}

describe("parseCurrencyValue", () => {
  it.each([
    [" $1,492,204 ", 1_492_204],
    ["$1,492,204.50", 1_492_204.5],
    ["1,234", 1234],
    ["€12.50", 12.5],
    ["12.50 €", 12.5],
    ["£ 3", 3],
    ["¥1,000", 1000],
    ["1.234,56 €", 1234.56],
    ["(500)", -500],
    ["($1,250.00)", -1250],
    ["-$12", -12],
    ["$-12", -12],
    ["42", 42],
    ["0.5", 0.5],
  ])("reads %j as %d", (text, expected) => {
    expect(numberOf(text)).toStrictEqual(expected);
  });

  it("passes numbers through unmarked", () => {
    expect(parseCurrencyValue(7)).toStrictEqual({
      kind: "number",
      marked: false,
      symbol: null,
      value: 7,
    });
  });

  it("marks symbols, separators and parentheses, not plain decimals", () => {
    expect(marked("$5")).toBe(true);
    expect(marked("1,000")).toBe(true);
    expect(marked("(5)")).toBe(true);
    expect(marked("5.25")).toBe(false);
  });

  it("reports the symbol", () => {
    const parsed = parseCurrencyValue("12 €");
    expect(parsed.kind === "number" ? parsed.symbol : "none").toBe("€");
  });

  it("treats blank text and null as blank, never zero", () => {
    expect(parseCurrencyValue("   ").kind).toBe("blank");
    expect(parseCurrencyValue(null).kind).toBe("blank");
    expect(parseCurrencyValue(undefined).kind).toBe("blank");
  });

  it.each([
    ["€1.234", "could be a decimal"],
    ["1,23,456", "not a number"],
    ["$€5", "more than one"],
    ["12 USD", "not a number"],
    ["abc", "not a number"],
    ["0x1F", "not a number"],
    [".5", "not a number"],
  ])("refuses %j", (text, reason) => {
    const parsed = parseCurrencyValue(text);
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" ? parsed.reason : "").toContain(reason);
  });

  it("refuses amounts too large to be finite", () => {
    const huge = "9".repeat(400);
    expect(parseCurrencyValue(huge)).toStrictEqual({ kind: "invalid", reason: "out of range" });
  });

  it("refuses booleans and objects", () => {
    expect(parseCurrencyValue(true).kind).toBe("invalid");
    expect(parseCurrencyValue({}).kind).toBe("invalid");
  });
});

describe("detectCurrencyColumns", () => {
  const rows = [
    { Amount: "$1,000", Count: 3, Name: "A", Ratio: "0.5", Spent: " $12.50 " },
    { Amount: "$2,500.75", Count: 4, Name: "B", Ratio: "0.25", Spent: "" },
    { Amount: "($300)", Count: 5, Name: "C", Ratio: "0.75", Spent: "$4" },
  ];

  it("suggests text columns with currency markers", () => {
    expect(detectCurrencyColumns(rows)).toStrictEqual([
      { field: "Amount", mixedSymbols: false, parsed: 3, sampled: 3, symbol: "$" },
      { field: "Spent", mixedSymbols: false, parsed: 2, sampled: 2, symbol: "$" },
    ]);
  });

  it("skips real numbers, plain decimal text and names", () => {
    const fields = detectCurrencyColumns(rows).map((guess) => guess.field);
    expect(fields).not.toContain("Count");
    expect(fields).not.toContain("Ratio");
    expect(fields).not.toContain("Name");
  });

  it("needs most values to parse", () => {
    const mostlyText = [{ X: "$1" }, { X: "n/a" }, { X: "pending" }, { X: "tbd" }];
    expect(detectCurrencyColumns(mostlyText)).toStrictEqual([]);
    expect(detectCurrencyColumns(mostlyText, { minRatio: 0.25 })).toHaveLength(1);
  });

  it("flags mixed symbols instead of picking one", () => {
    const [guess] = detectCurrencyColumns([{ X: "$1" }, { X: "€2" }]);
    expect(guess).toMatchObject({ mixedSymbols: true, symbol: null });
  });

  it("returns nothing for no rows", () => {
    expect(detectCurrencyColumns([])).toStrictEqual([]);
  });
});

describe("convertCurrencyColumn", () => {
  it("types parsed values, drops blanks and reports failures without touching them", () => {
    const input = [{ A: "$1,000", B: 1 }, { A: " ", B: 2 }, { A: "n/a", B: 3 }, { B: 4 }];
    const result = convertCurrencyColumn(input, "A");
    expect(result.rows).toStrictEqual([{ A: 1000, B: 1 }, { B: 2 }, { A: "n/a", B: 3 }, { B: 4 }]);
    expect(result.converted).toBe(1);
    expect(result.blanks).toBe(1);
    expect(result.failures).toStrictEqual([
      { index: 2, reason: '"n/a" is not a number', value: "n/a" },
    ]);
  });

  it("does not mutate its input", () => {
    const input = [{ A: "$5" }];
    convertCurrencyColumn(input, "A");
    expect(input).toStrictEqual([{ A: "$5" }]);
  });
});

import { describe, expect, it } from "vitest";

import { computeStat, formatStatValue, groupRows, numericValue, OTHER_LABEL } from "./aggregate";

const rows = [
  { amount: 10, state: "VA" },
  { amount: "20", state: "VA" },
  { amount: 5, state: "MD" },
  { amount: null, state: "MD" },
  { amount: 100, state: "CA" },
  { amount: 1, state: undefined },
];

describe("numericValue", () => {
  it("accepts numbers and numeric strings, rejects blanks and text", () => {
    expect(numericValue(3)).toBe(3);
    expect(numericValue("1,250.5")).toBe(1250.5);
    expect(numericValue("")).toBeUndefined();
    expect(numericValue("abc")).toBeUndefined();
    expect(numericValue(Number.NaN)).toBeUndefined();
  });
});

describe("computeStat", () => {
  it("counts every row and aggregates numeric values only", () => {
    expect(computeStat(rows, "count", undefined)).toBe(6);
    expect(computeStat(rows, "sum", "amount")).toBe(136);
    expect(computeStat(rows, "avg", "amount")).toBeCloseTo(27.2);
    expect(computeStat(rows, "max", "amount")).toBe(100);
    expect(computeStat([], "min", "amount")).toBeNull();
    expect(computeStat(rows, "sum", undefined)).toBeNull();
  });
});

describe("groupRows", () => {
  it("groups, ranks by value, and labels blanks", () => {
    expect(
      groupRows(rows, { aggregate: "count", groupBy: "state", limit: 10, sort: "value-desc" }),
    ).toEqual([
      { label: "VA", value: 2 },
      { label: "MD", value: 2 },
      { label: "CA", value: 1 },
      { label: "(blank)", value: 1 },
    ]);
  });

  it("folds groups past the limit into Other, aggregated over the folded rows", () => {
    const result = groupRows(rows, {
      aggregate: "avg",
      groupBy: "state",
      limit: 1,
      sort: "value-desc",
      valueField: "amount",
    });
    expect(result[0]).toEqual({ label: "CA", value: 100 });
    // VA (10, 20), MD (5), blank (1) → (10 + 20 + 5 + 1) / 4
    expect(result[1]).toEqual({ label: OTHER_LABEL, value: 9 });
  });

  it("orders labels naturally when asked", () => {
    const years = [{ y: "2010" }, { y: "2009" }, { y: "2100" }, { y: "2009" }];
    expect(
      groupRows(years, { aggregate: "count", groupBy: "y", limit: 10, sort: "label-asc" }).map(
        (group) => group.label,
      ),
    ).toEqual(["2009", "2010", "2100"]);
  });
});

describe("formatStatValue", () => {
  it("prints min/max years without a thousands separator", () => {
    expect(formatStatValue(1872, "min")).toBe("1872");
    expect(formatStatValue(1872, "sum")).not.toBe("1872");
  });
});

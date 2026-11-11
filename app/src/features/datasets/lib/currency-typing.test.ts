import { describe, expect, it } from "vitest";

import {
  currencySchemaOf,
  planBlocker,
  planCurrencyTyping,
  rewriteValuesOf,
  textColumnsOf,
} from "./currency-typing";

const rows = [
  { data: { Amount: " $1,492,204 ", Name: "A" }, id: "e1" },
  { data: { Amount: "($500)", Name: "B" }, id: "e2" },
  { data: { Amount: "", Name: "C" }, id: "e3" },
  { data: { Amount: "n/a", Name: "D" }, id: "e4" },
  { data: { Name: "E" }, id: "e5" },
];

const schema = {
  properties: {
    Amount: { title: "Award", type: "string" },
    Count: { type: ["integer", "null"] },
    Name: { type: ["string", "null"] },
  },
  required: ["Amount", "Name"],
  type: "object",
};

describe("textColumnsOf", () => {
  it("lists properties declared as text", () => {
    expect(textColumnsOf(schema)).toStrictEqual(["Amount", "Name"]);
    expect(textColumnsOf({})).toStrictEqual([]);
  });
});

describe("planCurrencyTyping", () => {
  it("counts conversions, blanks and failures with their row", () => {
    const plan = planCurrencyTyping(rows, "Amount");
    expect(plan).toStrictEqual({
      blanks: 1,
      converted: 2,
      failures: [{ id: "e4", reason: '"n/a" is not a number', row: 4, value: "n/a" }],
      field: "Amount",
      present: 4,
      symbol: "$",
    });
  });

  it("reports mixed symbols as null", () => {
    const plan = planCurrencyTyping(
      [
        { data: { X: "$1" }, id: "a" },
        { data: { X: "€1" }, id: "b" },
      ],
      "X",
    );
    expect(plan.symbol).toBeNull();
    expect(planBlocker(plan, true)).toContain("mix");
  });

  it("uses an empty symbol for amounts with none", () => {
    expect(planCurrencyTyping([{ data: { X: "1,000" }, id: "a" }], "X").symbol).toBe("");
  });
});

describe("planBlocker", () => {
  it("blocks on failures until the user clears them", () => {
    const plan = planCurrencyTyping(rows, "Amount");
    expect(planBlocker(plan, false)).toContain("don't read as amounts");
    expect(planBlocker(plan, true)).toBeUndefined();
  });

  it("blocks a column with nothing to convert", () => {
    expect(planBlocker(planCurrencyTyping(rows, "Name"), true)).toContain("No value");
  });
});

describe("rewriteValuesOf", () => {
  it("writes numbers, removes blanks, and leaves failures unless cleared", () => {
    expect(rewriteValuesOf(rows, "Amount", false)).toStrictEqual([
      { id: "e1", value: 1_492_204 },
      { id: "e2", value: -500 },
      { id: "e3", value: null },
    ]);
    expect(rewriteValuesOf(rows, "Amount", true)).toContainEqual({ id: "e4", value: null });
  });
});

describe("currencySchemaOf", () => {
  it("types the property, adds the hint, keeps annotations, and drops required when rows lose it", () => {
    const plan = planCurrencyTyping(rows, "Amount"),
      next = currencySchemaOf(schema, plan, true, rows.length);
    expect(next.properties).toMatchObject({
      Amount: { title: "Award", type: "number", "x-currency": "$" },
    });
    expect(next.required).toStrictEqual(["Name"]);
  });

  it("keeps required when every row keeps a number", () => {
    const full = [
        { data: { Amount: "$1" }, id: "a" },
        { data: { Amount: "$2" }, id: "b" },
      ],
      next = currencySchemaOf(schema, planCurrencyTyping(full, "Amount"), false, full.length);
    expect(next.required).toStrictEqual(["Amount", "Name"]);
  });
});

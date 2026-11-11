import { describe, expect, it } from "vitest";

import { applyCurrencySuggestion, describeFailures } from "./import-suggestions.js";

const schema = JSON.stringify({
  properties: {
    Amount: { description: "Award", type: "string" },
    Name: { type: "string" },
  },
  required: ["Amount", "Name"],
  title: "",
  type: "object",
});

describe("applyCurrencySuggestion", () => {
  it("rewrites values to numbers and types the property", () => {
    const rows = [
      { data: { Amount: "$1,000", Name: "A" } },
      { data: { Amount: "($250.50)", Name: "B" }, geometry: undefined },
    ];
    const result = applyCurrencySuggestion(rows, schema, "Amount", "$");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.rows.map((row) => row.data)).toStrictEqual([
      { Amount: 1000, Name: "A" },
      { Amount: -250.5, Name: "B" },
    ]);
    const parsed = JSON.parse(result.schemaJson);
    expect(parsed.properties.Amount).toStrictEqual({
      description: "Award",
      type: "number",
      "x-currency": "$",
    });
    expect(parsed.required).toStrictEqual(["Amount", "Name"]);
    expect(result.converted).toBe(2);
  });

  it("drops blanks and makes the field optional", () => {
    const result = applyCurrencySuggestion(
      [{ data: { Amount: "$5", Name: "A" } }, { data: { Amount: "  ", Name: "B" } }],
      schema,
      "Amount",
    );
    expect(result.ok && result.rows[1].data).toStrictEqual({ Name: "B" });
    expect(result.ok && JSON.parse(result.schemaJson).required).toStrictEqual(["Name"]);
  });

  it("drops nulls like blanks, so the type stays a plain number", () => {
    const result = applyCurrencySuggestion(
      [{ data: { Amount: "$5" } }, { data: { Amount: null } }],
      schema,
      "Amount",
    );
    expect(result.ok && result.rows[1].data).toStrictEqual({});
    expect(result.ok && JSON.parse(result.schemaJson).properties.Amount.type).toBe("number");
  });

  it("refuses and lists the rows that don't parse, changing nothing", () => {
    const rows = [{ data: { Amount: "$5" } }, { data: { Amount: "n/a" } }];
    const result = applyCurrencySuggestion(rows, schema, "Amount");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain('"n/a" (row 2)');
    expect(rows[1].data.Amount).toBe("n/a");
  });

  it("leaves non-object rows alone", () => {
    const result = applyCurrencySuggestion(
      [{ data: "x" }, { data: { Amount: "$1" } }],
      schema,
      "Amount",
    );
    expect(result.ok && result.rows[0].data).toBe("x");
  });
});

describe("describeFailures", () => {
  it("shows the first few and counts the rest", () => {
    const failures = [0, 1, 2, 3, 4].map((index) => ({ index, reason: "", value: `v${index}` }));
    expect(describeFailures(failures)).toBe('"v0" (row 1), "v1" (row 2), "v2" (row 3) and 2 more');
  });
});

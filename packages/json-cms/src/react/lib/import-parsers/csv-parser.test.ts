import { describe, expect, it } from "vitest";

import { parseCsvText } from "./csv-parser.js";

describe("parseCsvText", () => {
  it("parses a simple CSV with headers", () => {
    const { sheets, errors } = parseCsvText("name,age\nAda,30\nGrace,85");
    expect(errors).toStrictEqual([]);
    expect(sheets).toStrictEqual([
      {
        name: "Sheet1",
        rows: [
          { age: 30, name: "Ada" },
          { age: 85, name: "Grace" },
        ],
      },
    ]);
  });

  it("coerces numbers and booleans, but leaves other text as strings", () => {
    const { sheets } = parseCsvText("id,active,label\n1,true,North\n2,false,South");
    expect(sheets[0].rows).toStrictEqual([
      { active: true, id: 1, label: "North" },
      { active: false, id: 2, label: "South" },
    ]);
  });

  it("treats a blank cell as missing (undefined), not an empty string", () => {
    const { sheets } = parseCsvText("name,nickname\nAda,\nGrace,Amazing");
    expect(sheets[0].rows).toStrictEqual([
      { name: "Ada", nickname: undefined },
      { name: "Grace", nickname: "Amazing" },
    ]);
  });

  it("handles quoted fields with embedded commas, newlines, and escaped quotes", () => {
    const { sheets, errors } = parseCsvText(
      'name,bio\n"Doe, Jane","Loves ""quotes""\nand new lines"',
    );
    expect(errors).toStrictEqual([]);
    expect(sheets[0].rows).toStrictEqual([
      { bio: 'Loves "quotes"\nand new lines', name: "Doe, Jane" },
    ]);
  });

  it("synthesizes a header for a blank header cell", () => {
    const { sheets } = parseCsvText("name,,age\nAda,x,30");
    expect(sheets[0].rows).toStrictEqual([{ age: 30, column_2: "x", name: "Ada" }]);
  });

  it("reports a mismatched column count as a row error and skips that row", () => {
    const { sheets, errors } = parseCsvText("a,b\n1,2\n3");
    expect(sheets[0].rows).toStrictEqual([{ a: 1, b: 2 }]);
    expect(errors).toStrictEqual([{ line: 3, message: "Row has 1 column(s), expected 2." }]);
  });

  it("returns no sheets for blank input", () => {
    expect(parseCsvText("   \n  ")).toStrictEqual({ errors: [], sheets: [] });
  });

  it("returns no sheets when only a header row is present", () => {
    expect(parseCsvText("a,b")).toStrictEqual({ errors: [], sheets: [] });
  });
});

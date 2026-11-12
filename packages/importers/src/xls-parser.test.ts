import { describe, expect, it } from "vitest";
import * as SheetJs from "xlsx";

import { parseWorkbookBuffer, xlsParser } from "./xls-parser.js";

/** Builds a real legacy binary workbook buffer (BIFF8) with the given sheets. */
function buildWorkbookBuffer(
  sheetsSpec: { name: string; rows: (string | number | boolean | null)[][] }[],
): ArrayBuffer {
  const workbook = SheetJs.utils.book_new();
  for (const { name, rows } of sheetsSpec) {
    SheetJs.utils.book_append_sheet(workbook, SheetJs.utils.aoa_to_sheet(rows), name);
  }
  const out = SheetJs.write(workbook, { bookType: "biff8", type: "array" });
  return out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer;
}

describe("parseWorkbookBuffer", () => {
  it("parses a single-sheet legacy workbook into one sheet of row objects", async () => {
    const buffer = buildWorkbookBuffer([
        {
          name: "People",
          rows: [
            ["name", "age"],
            ["Ada", 30],
            ["Grace", 85],
          ],
        },
      ]),
      { sheets, errors } = await parseWorkbookBuffer(buffer);
    expect(errors).toStrictEqual([]);
    expect(sheets).toStrictEqual([
      {
        name: "People",
        rows: [
          { age: 30, name: "Ada" },
          { age: 85, name: "Grace" },
        ],
      },
    ]);
  });

  it("parses every sheet in a multi-sheet workbook", async () => {
    const buffer = buildWorkbookBuffer([
        { name: "Sheet1", rows: [["a"], [1], [2]] },
        { name: "Sheet2", rows: [["b"], [3]] },
      ]),
      { sheets } = await parseWorkbookBuffer(buffer);
    expect(sheets.map((s) => s.name)).toStrictEqual(["Sheet1", "Sheet2"]);
    expect(sheets[0].rows).toStrictEqual([{ a: 1 }, { a: 2 }]);
    expect(sheets[1].rows).toStrictEqual([{ b: 3 }]);
  });

  it("skips a completely empty sheet and reports a header-only sheet as an error", async () => {
    const buffer = buildWorkbookBuffer([
        { name: "Empty", rows: [] },
        { name: "HeaderOnly", rows: [["a", "b"]] },
        { name: "Data", rows: [["a"], [1]] },
      ]),
      { sheets, errors } = await parseWorkbookBuffer(buffer);
    expect(sheets.map((s) => s.name)).toStrictEqual(["Data"]);
    expect(errors).toStrictEqual([
      { message: 'Sheet "HeaderOnly" has no data rows.', sheet: "HeaderOnly" },
    ]);
  });

  it("skips a sheet whose first row is blank (no header row)", async () => {
    const buffer = buildWorkbookBuffer([{ name: "NoHeader", rows: [[], ["a", 1]] }]),
      { sheets, errors } = await parseWorkbookBuffer(buffer);
    expect(sheets).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
  });

  it("synthesizes column_N for whitespace-only header cells", async () => {
    // A fully blank header cell doesn't survive the BIFF8 round-trip (the
    // writer drops empty cells), so whitespace-only is the closest real shape.
    const buffer = buildWorkbookBuffer([
        {
          name: "S",
          rows: [
            ["name", " "],
            ["Ada", 30],
          ],
        },
      ]),
      { sheets } = await parseWorkbookBuffer(buffer);
    expect(sheets[0].rows).toStrictEqual([{ column_2: 30, name: "Ada" }]);
  });

  it("keeps string values intact, including spaces", async () => {
    const buffer = buildWorkbookBuffer([
        {
          name: "S",
          rows: [
            ["place", "note"],
            ["Route 9 Boston", "two words here"],
          ],
        },
      ]),
      { sheets } = await parseWorkbookBuffer(buffer);
    expect(sheets[0].rows).toStrictEqual([{ note: "two words here", place: "Route 9 Boston" }]);
  });
});

describe("xlsParser", () => {
  it("claims .xls files by extension and MIME type", () => {
    expect(xlsParser.matches(new File(["x"], "data.xls"))).toBe(true);
    expect(xlsParser.matches(new File(["x"], "data", { type: "application/vnd.ms-excel" }))).toBe(
      true,
    );
    expect(xlsParser.matches(new File(["x"], "data.xlsx"))).toBe(false);
    expect(xlsParser.matches(new File(["x"], "data.csv"))).toBe(false);
  });
});

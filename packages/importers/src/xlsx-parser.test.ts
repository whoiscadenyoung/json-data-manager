import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseWorkbookBuffer } from "./xlsx-parser.js";

async function buildWorkbookBuffer(
  sheetsSpec: { name: string; rows: (string | number | boolean)[][] }[],
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  for (const { name, rows } of sheetsSpec) {
    const sheet = workbook.addWorksheet(name);
    for (const row of rows) {
      sheet.addRow(row);
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer).buffer;
}

describe("parseWorkbookBuffer", () => {
  it("parses a single-sheet workbook into one sheet of row objects", async () => {
    const buffer = await buildWorkbookBuffer([
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
    const buffer = await buildWorkbookBuffer([
        { name: "Sheet1", rows: [["a"], [1], [2]] },
        { name: "Sheet2", rows: [["b"], [3]] },
      ]),
      { sheets } = await parseWorkbookBuffer(buffer);
    expect(sheets.map((s) => s.name)).toStrictEqual(["Sheet1", "Sheet2"]);
    expect(sheets[0].rows).toStrictEqual([{ a: 1 }, { a: 2 }]);
    expect(sheets[1].rows).toStrictEqual([{ b: 3 }]);
  });

  it("skips a completely empty sheet and reports a header-only sheet as an error", async () => {
    const buffer = await buildWorkbookBuffer([
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
});

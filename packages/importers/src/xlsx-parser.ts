/**
 * Excel workbook parsing via `exceljs`. `exceljs` is dynamically imported
 * inside `parse()` rather than at module scope so it's never pulled into a
 * server-rendered bundle — this module is only ever exercised client-side,
 * in response to a user picking a real `File`, but a static import would
 * still make bundlers try to include (and TanStack Start's SSR try to
 * evaluate) the library eagerly, the same reasoning that keeps the CodeMirror
 * editor lazy elsewhere in this app.
 *
 * Every worksheet in the workbook is parsed; sheets with no header row are
 * skipped, and sheets with a header but no data rows are reported as errors
 * rather than silently dropped. The caller decides what to do with more than
 * one resulting sheet (e.g. let the user pick one).
 */
import type {
  CellErrorValue,
  CellFormulaValue,
  CellHyperlinkValue,
  CellRichTextValue,
  CellSharedFormulaValue,
  CellValue,
  Worksheet,
} from "exceljs";

import { readFileAsArrayBuffer } from "./file-utils.js";
import type { ImportParseResult, ImportParser, ParsedSheet } from "./types.js";

type ObjectCellValue =
  | CellErrorValue
  | CellRichTextValue
  | CellHyperlinkValue
  | CellFormulaValue
  | CellSharedFormulaValue;

/** Handles the object-shaped `CellValue` variants: formula results, rich text, hyperlinks, and errors. */
function objectCellValueToJs(value: ObjectCellValue): unknown {
  if ("error" in value) {
    return undefined;
  }
  if ("result" in value) {
    return cellValueToJs(value.result);
  }
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if ("text" in value) {
    return value.text;
  }
  return JSON.stringify(value);
}

/** Reduces an exceljs `CellValue` (which may be a formula/hyperlink/rich-text object) down to a plain JSON-ish value. */
function cellValueToJs(value: CellValue): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return value;
  }
  return objectCellValueToJs(value);
}

function rowValues(row: { values: CellValue[] | Record<string, CellValue> }): CellValue[] {
  return Array.isArray(row.values) ? row.values : [];
}

/** The worksheet's header names (row 1), synthesizing `column_N` for any blank header cell. Empty when the sheet has no header row at all. */
function worksheetHeaders(worksheet: Worksheet): string[] {
  const values = rowValues(worksheet.getRow(1)),
    headers: string[] = [];
  for (let col = 1; col < values.length; col += 1) {
    const cellValue = cellValueToJs(values[col]);
    headers.push(
      typeof cellValue === "string" && cellValue.trim().length > 0
        ? cellValue.trim()
        : `column_${col}`,
    );
  }
  return headers;
}

/** Every non-blank data row (rows 2..end) as an object keyed by `headers`. */
function worksheetRows(worksheet: Worksheet, headers: string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = rowValues(worksheet.getRow(rowNumber));
    if (values.length <= 1) {
      continue;
    }
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    for (const [index, header] of headers.entries()) {
      const value = cellValueToJs(values[index + 1]);
      if (value !== undefined) {
        hasValue = true;
      }
      obj[header] = value;
    }
    if (hasValue) {
      rows.push(obj);
    }
  }
  return rows;
}

/** Core parsing logic, decoupled from the browser `File`/`FileReader` APIs so it's directly testable in a non-DOM test environment. */
export async function parseWorkbookBuffer(buffer: ArrayBuffer): Promise<ImportParseResult> {
  const { Workbook } = await import("exceljs"),
    workbook = new Workbook();
  await workbook.xlsx.load(buffer);

  const sheets: ParsedSheet[] = [],
    errors: ImportParseResult["errors"] = [];

  for (const worksheet of workbook.worksheets) {
    const headers = worksheetHeaders(worksheet);
    if (headers.length === 0) {
      continue;
    }
    const rows = worksheetRows(worksheet, headers);
    if (rows.length > 0) {
      sheets.push({ name: worksheet.name, rows });
    } else {
      errors.push({
        message: `Sheet "${worksheet.name}" has no data rows.`,
        sheet: worksheet.name,
      });
    }
  }

  return { errors, sheets };
}

export async function parseWorkbookFile(file: File): Promise<ImportParseResult> {
  return parseWorkbookBuffer(await readFileAsArrayBuffer(file));
}

export const xlsxParser: ImportParser = {
  accept:
    ".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12",
  extensions: [".xlsx", ".xlsm"],
  id: "xlsx",
  label: "Excel Workbook",
  matches: (file) =>
    /\.(xlsx|xlsm)$/i.test(file.name) ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  parse: parseWorkbookFile,
};

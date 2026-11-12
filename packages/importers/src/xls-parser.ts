/**
 * Legacy Excel workbook parsing (the binary `.xls` BIFF format) via SheetJS.
 * `exceljs` reads only the OOXML `.xlsx`/`.xlsm` containers, so `.xls` gets
 * its own parser built on the `xlsx` package (installed from the SheetJS CDN
 * tarball — the npm copy stopped at an unpatched version).
 *
 * SheetJS is dynamically imported inside `parse()` rather than at module
 * scope, mirroring `xlsx-parser.ts`: the library is only ever exercised
 * client-side in response to a real `File`, and a static import would pull it
 * into the SSR-evaluated bundle.
 *
 * Every worksheet is parsed; sheets with no header row are skipped, and
 * sheets with a header but no data rows are reported as errors rather than
 * silently dropped — the same sheet semantics as `xlsx-parser.ts`.
 */
import { readFileAsArrayBuffer } from "./file-utils.js";
import type { ImportParseResult, ImportParser, ParsedSheet } from "./types.js";

/** Reduces a SheetJS cell value to a plain JSON-ish value (dates → ISO strings, matching `xlsx-parser`). */
function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/** Synthesizes `column_N` for blank header cells, mirroring `xlsx-parser`'s header handling. */
function headerName(cell: unknown, index: number): string {
  const name =
    typeof cell === "string"
      ? cell.trim()
      : typeof cell === "number" || typeof cell === "boolean"
        ? String(cell).trim()
        : "";
  return name.length > 0 ? name : `column_${index + 1}`;
}

/** Turns a header-first matrix (`sheet_to_json` with `header: 1`) into row objects; blank rows are skipped. */
function buildObjects(matrix: unknown[][]): Record<string, unknown>[] {
  const [rawHeaders, ...dataRows] = matrix,
    headers = rawHeaders.map(headerName),
    rows: Record<string, unknown>[] = [];
  for (const dataRow of dataRows) {
    if (dataRow.every((cell) => cell === null || cell === undefined)) {
      continue;
    }
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    for (const [index, header] of headers.entries()) {
      const value = normalizeCell(dataRow[index]);
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

/** Core parsing logic over a buffer, decoupled from the browser `File` API for non-DOM tests. */
export async function parseWorkbookBuffer(buffer: ArrayBuffer): Promise<ImportParseResult> {
  // Dynamic import — see the module comment.
  const { read, utils } = await import("xlsx"),
    workbook = read(new Uint8Array(buffer), { cellDates: true, type: "array" }),
    sheets: ParsedSheet[] = [],
    errors: ImportParseResult["errors"] = [];

  for (const name of workbook.SheetNames) {
    const matrix = utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1 });
    // No header row at all (empty sheet, or first row blank in BIFF8's
    // re-read shape) — skip silently, same as `xlsx-parser`'s empty-headers
    // worksheet branch.
    if (matrix.length === 0 || matrix[0].length === 0) {
      continue;
    }
    const rows = buildObjects(matrix);
    if (rows.length > 0) {
      sheets.push({ name, rows });
    } else {
      errors.push({ message: `Sheet "${name}" has no data rows.`, sheet: name });
    }
  }

  return { errors, sheets };
}

export async function parseWorkbookFile(file: File): Promise<ImportParseResult> {
  return parseWorkbookBuffer(await readFileAsArrayBuffer(file));
}

export const xlsParser: ImportParser = {
  accept: ".xls,application/vnd.ms-excel,application/msexcel,application/xls",
  extensions: [".xls"],
  id: "xls",
  label: "Excel Workbook (legacy)",
  matches: (file) =>
    /\.xls$/i.test(file.name) ||
    file.type === "application/vnd.ms-excel" ||
    file.type === "application/msexcel",
  parse: parseWorkbookFile,
};

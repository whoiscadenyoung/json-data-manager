/** The plain JSON/JSONL parser, wrapped as an `ImportParser` for the registry. Delegates entirely to `parseDataRows` — see that module for the parsing strategy. */
import { parseDataRows } from "../parse-data.js";
import { readFileAsText } from "./file-utils.js";
import type { ImportParseResult, ImportParser } from "./types.js";

export async function parseJsonFile(file: File): Promise<ImportParseResult> {
  const text = await readFileAsText(file),
    { rows, errors } = parseDataRows(text);
  return {
    errors: errors.map((e) => ({ line: e.line, message: e.message })),
    sheets: rows.length > 0 ? [{ name: file.name, rows }] : [],
  };
}

export const jsonParser: ImportParser = {
  accept: ".json,.jsonl,.ndjson,application/json,application/x-ndjson",
  extensions: [".json", ".jsonl", ".ndjson"],
  id: "json",
  label: "JSON / JSONL",
  matches: (file) =>
    /\.(json|jsonl|ndjson)$/i.test(file.name) ||
    file.type === "application/json" ||
    file.type === "application/x-ndjson",
  parse: parseJsonFile,
};

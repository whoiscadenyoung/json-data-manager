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
  accept:
    ".json,.jsonl,.ndjson,.geojson,application/json,application/x-ndjson,application/geo+json,application/vnd.geo+json",
  extensions: [".json", ".jsonl", ".ndjson", ".geojson"],
  id: "json",
  label: "JSON / JSONL",
  matches: (file) =>
    /\.(json|jsonl|ndjson|geojson)$/i.test(file.name) ||
    file.type === "application/json" ||
    file.type === "application/x-ndjson" ||
    file.type === "application/geo+json" ||
    file.type === "application/vnd.geo+json",
  parse: parseJsonFile,
};

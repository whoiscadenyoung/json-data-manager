/**
 * `@caden/importers` — browser-side tabular import parsing: `parseDataRows`
 * for JSON/JSONL text, and the pluggable parser registry (JSON/JSONL, CSV,
 * Excel). See ./registry.ts for how to add or disable a format.
 */
export { parseDataRows } from "./parse-data.js";
export type { ParseDataResult, ParseError } from "./parse-data.js";
export {
  enabledAcceptString,
  enabledExtensionsHint,
  findImportParser,
  getAllImportParsers,
  getEnabledImportParsers,
} from "./registry.js";
export type { ImportParseError, ImportParser, ImportParseResult, ParsedSheet } from "./types.js";

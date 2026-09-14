/**
 * Every import parser the app knows about, plus whether it's active.
 *
 * To add a format: implement `ImportParser` in its own module (see
 * `csv-parser.ts` for the smallest example) and add one line here. To remove
 * or temporarily disable a format: flip its `enabled` flag to `false`, or
 * delete its line — nothing else in the codebase references a specific
 * parser by name. The dataset-creation and bulk-upload import UIs both drive
 * entirely off `getEnabledImportParsers`/`findImportParser`/`enabledAcceptString`,
 * so a format that's turned off here simply stops being offered anywhere,
 * with no other code to touch.
 */
import { csvParser } from "./csv-parser.js";
import { jsonParser } from "./json-parser.js";
import type { ImportParser } from "./types.js";
import { xlsxParser } from "./xlsx-parser.js";

interface RegisteredParser {
  parser: ImportParser;
  enabled: boolean;
}

const REGISTRY: RegisteredParser[] = [
  { enabled: true, parser: jsonParser },
  { enabled: true, parser: csvParser },
  { enabled: true, parser: xlsxParser },
];

/** Enabled parsers, in registration order. */
export function getEnabledImportParsers(): ImportParser[] {
  return REGISTRY.filter((entry) => entry.enabled).map((entry) => entry.parser);
}

/** Every registered parser regardless of `enabled`, for introspection/tests. */
export function getAllImportParsers(): ImportParser[] {
  return REGISTRY.map((entry) => entry.parser);
}

/** The first enabled parser that claims this file, or `undefined` if none do. */
export function findImportParser(file: File): ImportParser | undefined {
  return getEnabledImportParsers().find((parser) => parser.matches(file));
}

/** Combined `accept` attribute string covering every enabled parser — feed straight into `<input accept={...}>`. */
export function enabledAcceptString(): string {
  return getEnabledImportParsers()
    .map((parser) => parser.accept)
    .join(",");
}

/** Comma-separated list of enabled extensions (e.g. ".json, .csv, .xlsx"), for dropzone hint text. */
export function enabledExtensionsHint(): string {
  return getEnabledImportParsers()
    .flatMap((parser) => parser.extensions)
    .join(", ");
}

/**
 * Shared contract every tabular import parser (CSV, Excel, plain JSON/JSONL,
 * ...) implements. Each parser is a self-contained module: it knows which
 * files it claims and how to turn one into rows, and nothing else in the
 * import UI needs to know the format's details. See `registry.ts` for how
 * parsers are wired up and toggled on/off.
 *
 * GeoJSON is deliberately not a registry entry — it needs to inspect the raw
 * parsed JSON *before* row-array collapsing to distinguish a FeatureCollection
 * from a one-row dataset, which this file-in/rows-out contract doesn't
 * support. See `geojson-import.ts`.
 */

/** One worksheet's worth of parsed rows. A CSV file always produces exactly one sheet; a workbook may produce several. */
export interface ParsedSheet {
  name: string;
  rows: unknown[];
}

export interface ImportParseError {
  sheet?: string;
  line?: number;
  message: string;
}

export interface ImportParseResult {
  sheets: ParsedSheet[];
  errors: ImportParseError[];
}

export interface ImportParser {
  /** Stable identifier, used only for the registry's own bookkeeping/tests. */
  id: string;
  /** Human-readable label (e.g. shown in error messages). */
  label: string;
  /** Lowercase extensions this parser claims, each with a leading dot. */
  extensions: string[];
  /** `accept` attribute fragment for a `<input type="file">`. */
  accept: string;
  /** Whether this parser should handle the given file. */
  matches: (file: File) => boolean;
  /** Parse the file into one or more sheets of rows. May reject with an Error carrying a user-facing message. */
  parse: (file: File) => Promise<ImportParseResult>;
}

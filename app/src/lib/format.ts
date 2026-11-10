/** Human-readable value rendering for entry properties across tables and map popups. */
export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  // A collect-join's enrichment (ADR 0026) lands as per-field arrays: the
  // cells join readably instead of dumping JSON — object cells inside the
  // array still stringify (they have no primitive form).
  if (Array.isArray(value)) {
    return value
      .map((cell) =>
        cell === null || cell === undefined
          ? "—" // a match that lacked the field keeps the app's null glyph
          : typeof cell === "object"
            ? JSON.stringify(cell)
            : String(cell),
      )
      .join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  // oxlint-disable-next-line typescript/no-base-to-string -- narrowed to primitives here: nullish and objects return above.
  return String(value);
}

/** Byte size formatted for display — entry/GeoJSON payloads run from bytes to several MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human-readable value rendering for entry properties across tables and map popups. */
export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
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

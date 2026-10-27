/**
 * Stringifies an arbitrary cell/row value for display, search, or option-key
 * purposes. Primitives use their natural string form; objects/arrays fall
 * back to JSON so callers never emit `Object.prototype.toString`'s useless
 * `"[object Object]"`.
 */
export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

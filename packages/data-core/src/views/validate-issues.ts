import type { ValidationError } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Collects validation problems with their locations. */
export class Issues {
  readonly list: ValidationError[] = [];

  get count(): number {
    return this.list.length;
  }

  /** `position` is the offset range inside the string at `path` (expressions, SQL). */
  add(path: string, message: string, position?: { start: number; end: number }): void {
    this.list.push(
      position === undefined
        ? { path, message }
        : { path, message, position: { start: position.start, end: position.end } },
    );
  }
}

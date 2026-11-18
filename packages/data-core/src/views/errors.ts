import type { NodeKind } from "./types.js";

/** Thrown for step kinds / modes the compiler does not support yet. */
export class ViewNodeNotSupportedError extends Error {
  readonly kind: NodeKind | "measure";
  readonly mode: string | undefined;

  constructor(kind: NodeKind | "measure", mode?: string) {
    super(
      mode === undefined
        ? `View node "${kind}" is not supported yet.`
        : `View node "${kind}" mode "${mode}" is not supported yet.`,
    );
    this.name = "ViewNodeNotSupportedError";
    this.kind = kind;
    this.mode = mode;
  }
}

/** Thrown for definitions that cannot be compiled (validate first for a full report). */
export class ViewCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewCompileError";
  }
}

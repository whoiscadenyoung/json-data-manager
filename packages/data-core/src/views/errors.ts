import type { StepKind } from "./types.js";

/** Thrown for step kinds / modes the compiler does not support yet. */
export class ViewStepNotSupportedError extends Error {
  readonly kind: StepKind | "measure";
  readonly mode: string | undefined;

  constructor(kind: StepKind | "measure", mode?: string) {
    super(
      mode === undefined
        ? `View step "${kind}" is not supported yet.`
        : `View step "${kind}" mode "${mode}" is not supported yet.`,
    );
    this.name = "ViewStepNotSupportedError";
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

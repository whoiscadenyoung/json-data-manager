import type { ViewCompiler, ViewInputRef } from "./view-compiler";

/**
 * THE WIRING POINT (issue #300). The runner and preview modules receive a
 * `ViewCompiler`; this file is the single place that supplies the real one.
 *
 * Until the compiler PR (#299 / #309) is in this branch's base,
 * `defaultViewCompiler` throws a clear error on first use. To wire it:
 *
 *   import {
 *     compileDiagnostics, compileView, validateViewDefinition, viewInputDatasetIds,
 *   } from "@caden/data-core/views";
 *
 *   export const defaultViewCompiler: ViewCompiler = {
 *     validateViewDefinition, compileView, compileDiagnostics, viewInputDatasetIds,
 *   };
 *
 * (The subpath is `@caden/data-core/views`, not the package root. The
 * compiler's `{ unaccent }` option defaults to false: no migration installs
 * the extension.) Then adjust `inputsOfDefinition` below if the definition
 * format moved from design §4.
 */

class ViewCompilerNotWiredError extends Error {
  constructor() {
    super(
      "The view compiler is not wired yet: plug @caden/data-core/views in at view-compiler-wiring.ts (#299).",
    );
  }
}

function notWired(): never {
  throw new ViewCompilerNotWiredError();
}

export const defaultViewCompiler: ViewCompiler = {
  validateViewDefinition: notWired,
  compileView: notWired,
  compileDiagnostics: notWired,
  viewInputDatasetIds: notWired,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derives the `view_inputs` rows from a definition per design §4:
 * `inputs: { alias, ref: { kind: "dataset", id, version? } }[]`. Entries that
 * do not match are skipped (the compiler's validator reports them).
 */
export function inputsOfDefinition(definition: unknown): ViewInputRef[] {
  if (!isRecord(definition) || !Array.isArray(definition["inputs"])) {
    return [];
  }
  const out: ViewInputRef[] = [];
  for (const entry of definition["inputs"]) {
    if (!isRecord(entry)) {
      continue;
    }
    const ref = entry["ref"];
    if (typeof entry["alias"] !== "string" || !isRecord(ref) || typeof ref["id"] !== "string") {
      continue;
    }
    const version = ref["version"];
    out.push(
      typeof version === "string"
        ? { alias: entry["alias"], datasetId: ref["id"], pinnedVersion: version }
        : { alias: entry["alias"], datasetId: ref["id"] },
    );
  }
  return out;
}

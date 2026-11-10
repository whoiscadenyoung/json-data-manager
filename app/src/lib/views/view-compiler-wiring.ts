import {
  compileDiagnostics,
  compileView,
  validateViewDefinition,
  viewInputDatasetIds,
} from "@caden/data-core/views";

import type { ViewCompiler, ViewInputRef } from "./view-compiler";

/**
 * THE WIRING POINT (issue #300). The runner and preview modules receive a
 * `ViewCompiler`; this file is the single place that supplies the real one,
 * `@caden/data-core/views` (#299). `unaccent` stays at the compiler's default
 * (false): no migration installs the extension.
 */
export const defaultViewCompiler: ViewCompiler = {
  validateViewDefinition,
  compileView,
  compileDiagnostics,
  viewInputDatasetIds,
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

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
 * Derives the `view_inputs` rows from a definition: one per `source` node,
 * `nodes: { <id>: { kind: "source", ref: { kind: "dataset", id, version? } } }`
 * (the row's `alias` column holds the node id). Anything else is skipped (the
 * compiler's validator reports it).
 */
export function inputsOfDefinition(definition: unknown): ViewInputRef[] {
  if (!isRecord(definition) || !isRecord(definition["nodes"])) {
    return [];
  }
  const out: ViewInputRef[] = [];
  for (const [id, node] of Object.entries(definition["nodes"])) {
    if (!isRecord(node) || node["kind"] !== "source") {
      continue;
    }
    const ref = node["ref"];
    if (!isRecord(ref) || typeof ref["id"] !== "string") {
      continue;
    }
    const version = ref["version"];
    out.push(
      typeof version === "string"
        ? { alias: id, datasetId: ref["id"], pinnedVersion: version }
        : { alias: id, datasetId: ref["id"] },
    );
  }
  return out;
}

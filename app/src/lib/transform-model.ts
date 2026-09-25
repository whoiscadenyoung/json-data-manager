/**
 * Client-side model glue for the Transform tab (roadmap stage 2, #95) —
 * the pure layer between the builder's form state and the stage 1 engine's
 * spec shape (packages/json-cms spec.ts), plus the match-stat formatting
 * the preview renders (design doc §6 lines 140-142). React-free and
 * seam-free: rows and `applyLookup` meet in the preview component, never
 * here.
 */
import type { LookupDiagnostics, LookupOperation, TransformSpec } from "@caden/json-cms/react";

/** The "nothing picked yet" sentinel in select controls (the geospatial panel's NONE precedent). */
export const NO_COLUMN = "";

/** How many preview rows render below the stats (§8: "preview the first N rows" — the STATS are dataset-wide, only the table is capped). */
export const PREVIEW_ROW_COUNT = 20;

/** How many orphan keys list before the "+N more" truncation. */
export const ORPHAN_KEY_LIMIT = 5;

/**
 * One builder operation: the engine's LookupOperation plus the form's
 * fields mode — "all" (fields omitted; the engine then brings every field
 * but the join key, first-seen across the table) vs "pick" (fields set
 * explicitly). The distinction is UI-only; the registry stores plain
 * operations (spec.ts:47-53 fixes omit-means-all as the recorded answer to
 * the design doc's §11 open question).
 */
export interface BuilderOperation extends LookupOperation {
  fieldsMode: "all" | "pick";
}

export function emptyBuilderOperation(): BuilderOperation {
  return {
    baseKey: NO_COLUMN,
    fieldsMode: "all",
    kind: "lookup",
    lookupDatasetId: NO_COLUMN,
    lookupKey: NO_COLUMN,
  };
}

export function toBuilderOperation(operation: LookupOperation): BuilderOperation {
  return { ...operation, fieldsMode: operation.fields === undefined ? "all" : "pick" };
}

export function fromBuilderOperation(operation: BuilderOperation): LookupOperation {
  const { fields, fieldsMode, ...rest } = operation;
  // "all" means the field is OMITTED (spec.ts:47-53 — omit-means-all), not
  // present-but-undefined; switching a step back to all drops the pick.
  return fieldsMode === "all" ? rest : { ...rest, fields };
}

/** An operation is previewable/savable once the builder knows what it joins on. */
export function isLookupComplete(operation: BuilderOperation): boolean {
  return (
    firstIncompleteReason([operation]) === undefined
  );
}

/**
 * The first thing blocking a save, phrased for the person typing (the
 * UI-polish rule: required fields surface prominently — never a silently
 * disabled Save). Undefined = everything configured.
 */
export function firstIncompleteReason(operations: BuilderOperation[]): string | undefined {
  for (const [index, operation] of operations.entries()) {
    const label = `Lookup step ${index + 1}`;
    if (operation.lookupDatasetId === NO_COLUMN) {
      return `${label}: choose the related dataset.`;
    }
    if (operation.baseKey === NO_COLUMN) {
      return `${label}: choose the key column on this dataset.`;
    }
    if (operation.lookupKey === NO_COLUMN) {
      return `${label}: choose the key column on the related dataset.`;
    }
    if (operation.fieldsMode === "pick" && (operation.fields ?? []).length === 0) {
      return `${label}: pick at least one field, or switch back to all fields.`;
    }
  }
  return undefined;
}

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** One stored lookup record as a builder operation, or undefined when it isn't a lookup record. */
function builderOperationFromRecord(
  operation: Record<string, unknown>,
): BuilderOperation | undefined {
  if (operation.kind !== "lookup") {
    return undefined;
  }
  return toBuilderOperation({
    baseKey: stringOr(operation.baseKey, NO_COLUMN),
    fields: stringArrayOrUndefined(operation.fields),
    kind: "lookup",
    lookupDatasetId: stringOr(operation.lookupDatasetId, NO_COLUMN),
    lookupKey: stringOr(operation.lookupKey, NO_COLUMN),
    match: operation.match === "inner" || operation.match === "left" ? operation.match : undefined,
    namespace: optionalString(operation.namespace),
    onDuplicateKey:
      operation.onDuplicateKey === "error" ||
      operation.onDuplicateKey === "first" ||
      operation.onDuplicateKey === "last"
        ? operation.onDuplicateKey
        : undefined,
  });
}

/**
 * The stored spec's lookup operations, read structurally — the registry
 * stores specs shapeless (the schemaMapping precedent) and must stay
 * additive for stage 4's operation kinds, so anything that is not a lookup
 * record is skipped and malformed cells fall back to the builder's empty
 * sentinel for re-picking.
 */
export function builderOperationsFromSpec(spec: unknown): BuilderOperation[] {
  if (!isRecordShaped(spec) || !Array.isArray(spec.operations)) {
    return [];
  }
  const operations: BuilderOperation[] = [];
  for (const operation of spec.operations) {
    if (isRecordShaped(operation)) {
      const builder = builderOperationFromRecord(operation);
      if (builder !== undefined) {
        operations.push(builder);
      }
    }
  }
  return operations;
}

/** The registry-ready spec for the builder's state: complete operations only, in order. */
export function draftToSpec(sourceDatasetId: string, operations: BuilderOperation[]): TransformSpec {
  return {
    operations: operations.filter(isLookupComplete).map(fromBuilderOperation),
    sourceDatasetId,
  };
}

/** The datasets the spec reads — what the registry denormalizes into `dependsOn` at save time. */
export function specDatasetIds(spec: TransformSpec): string[] {
  return [spec.sourceDatasetId, ...spec.operations.map((operation) => operation.lookupDatasetId)];
}

/**
 * The §6 stat line, dataset-true: the diagnostics come from one
 * full-dataset `applyLookup` call over the row-resolution seam's imperative
 * path (§8 says "preview the first N rows" — the TABLE is capped, the stats
 * are not). The count is `unmatchedRows` so it stays consistent with the
 * percentage's denominator — the design's "87% of rows matched; 214 orphan
 * GrantIds" is a row count (lookup.ts:59-62); the DISTINCT orphan keys
 * render separately as the chips below the line. Example:
 * "87% matched; 1300 orphan GrantId".
 */
export function matchStatLine(diagnostics: LookupDiagnostics, baseKey: string): string {
  if (diagnostics.totalSourceRows === 0) {
    return "No rows to match yet.";
  }
  const percent = Math.round((diagnostics.matchedRows / diagnostics.totalSourceRows) * 100);
  return `${percent}% matched; ${diagnostics.unmatchedRows} orphan ${baseKey}`;
}

/** The orphan list a human reads: the first `limit` raw keys plus how many more (`unmatchedKeys` is unbounded). */
export function truncateOrphanKeys(
  keys: string[],
  limit = ORPHAN_KEY_LIMIT,
): { remaining: number; shown: string[] } {
  return { remaining: Math.max(keys.length - limit, 0), shown: keys.slice(0, limit) };
}

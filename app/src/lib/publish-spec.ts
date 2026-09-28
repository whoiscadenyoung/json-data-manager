/**
 * The publish executor's pure core (roadmap 5b, #100): run a stored
 * transform spec ONCE over pre-loaded source rows and pair every output row
 * with the geometry payload its `geometrySource` rule names — the chunk
 * producer's brain, split from the orchestrator (which owns the Convex
 * client and the uploads) so it stays unit-testable without either.
 *
 * React-free and Convex-free by the tile-worker rule: the only imports are
 * the pure engine through the `./transform` subpath. Execution is the
 * engine's chained pure calls (applyRollup → applyLookup — there is no
 * composition module), extended with exactly one piece of publish-specific
 * bookkeeping:
 *
 * **Geometry pairing at the geometry op's position.** `geometrySource`
 * addresses ONE lookup operation (`geometrySourceOperationOf`); that call's
 * index-paired `geometryReferences` are the only valid partners for its
 * rows — no later array adjusts when a later operation changes row count
 * (the recorded constraint, pinned by composition.test.ts's desync test).
 * This module consumes references AT that position and keeps the pairing
 * aligned as the pipeline continues:
 * - a later `lookup` under the default "left" match preserves rows 1:1 and
 *   the pairing passes through unchanged;
 * - a later `lookup` under `match: "inner"` drops rows, so the surviving
 *   input indices are re-derived by running the SAME operation over a
 *   throwaway index-carrying array — the engine stays the only matcher (no
 *   match-policy re-implementation, duplicate-key policy included);
 * - a later `rollup` cannot preserve the pairing at all (a group spans many
 *   rows — the recorded reason rollups have no geometry), so a spec shaped
 *   that way is rejected with a clear error instead of silently
 *   materializing without the geometry it names.
 *
 * **The geometry-reference column.** In this app's data model an entry's
 * geometry rides `entries.geometryId`, a field OUTSIDE the row's `data` —
 * so for the engine to see a reference, the orchestrator adapts each entry
 * record with that pointer injected under `PUBLISH_GEOMETRY_COLUMN`, and
 * this module strips the same key from the final rows (it is materialization
 * plumbing; the published rows carry the real geometry payload). Injection
 * and stripping are coordinated through `needsGeometryPlumbing`: a spec with
 * no resolvable `geometrySource` (or one naming a genuine data column)
 * neither injects nor strips, so real data named `geometryId` passes through
 * untouched unless a rule claims the column.
 */
import { applyLookup, applyRollup, geometrySourceOperationOf } from "@caden/json-cms/transform";
import type { GeometrySource, LookupOperation, RollupOperation } from "@caden/json-cms/transform";

/** The record key an entry's geometry pointer is injected under (see the module doc). */
export const PUBLISH_GEOMETRY_COLUMN = "geometryId";

/** The pre-loaded inputs of one publish execution, built by the orchestrator. */
export interface PublishSourceTables {
  /**
   * Component dataset id → its entries adapted as engine records. When
   * `needsGeometryPlumbing(spec)` is true, each record carries its entry's
   * geometry id under `PUBLISH_GEOMETRY_COLUMN`.
   */
  rowsByDatasetId: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  /** Registry row id → its stored spec (derived-of-derived sources). */
  specByDatasetId: ReadonlyMap<string, unknown>;
  /**
   * Every involved dataset's geometry payloads keyed by geometry row id —
   * component geometries are one table, so one merged map serves every side
   * of the join.
   */
  geometryById: ReadonlyMap<string, unknown>;
}

/** One execution's output: final data rows plus their index-paired geometry payloads. */
export interface PublishExecution {
  rows: Array<Record<string, unknown>>;
  /** `null` where a row carries no geometry — the chunk producer emits `{data}` for those. */
  geometryPayloads: Array<unknown>;
}

/** A spec the publish executor cannot honestly run. */
export class PublishSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishSpecError";
    Object.setPrototypeOf(this, PublishSpecError.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored spec's `geometrySource` rule, read structurally, or undefined. */
export function geometryRuleOf(spec: unknown): GeometrySource | undefined {
  if (!isRecord(spec) || !isRecord(spec.geometrySource)) {
    return undefined;
  }
  const rule = spec.geometrySource,
    side = rule.side;
  if (
    typeof rule.lookupDatasetId !== "string" ||
    typeof rule.column !== "string" ||
    (side !== "base" && side !== "lookup")
  ) {
    return undefined;
  }
  return { column: rule.column, lookupDatasetId: rule.lookupDatasetId, side };
}

/** The index of the lookup operation the rule addresses (first match in order), or -1 when none does. */
function geometryOpIndexOf(
  operations: Array<Record<string, unknown>>,
  rule: GeometrySource,
): number {
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "lookup" && operation.lookupDatasetId === rule.lookupDatasetId) {
      return index;
    }
  }
  return -1;
}

/**
 * Whether adapting input records with the injected geometry pointer (and
 * stripping it from the output) is part of THIS spec's publish: the rule
 * exists, resolves to an operation, and names the injected column. The one
 * function both the orchestrator's adaptation and the final strip derive
 * from, so they can never disagree. An unresolvable rule (a typo'd dataset
 * id) reads as "no geometry rule" per spec.ts — detectable, never a crash.
 */
export function needsGeometryPlumbing(spec: unknown): boolean {
  const rule = geometryRuleOf(spec);
  if (rule === undefined || rule.column !== PUBLISH_GEOMETRY_COLUMN || !isRecord(spec)) {
    return false;
  }
  const operations = Array.isArray(spec.operations) ? spec.operations : [];
  return (
    geometrySourceOperationOf(asEngineOperations(operations.filter(isRecord)), rule) !== undefined
  );
}

/** The stored operations array as the engine's union — the addressing reads ids and kinds only. */
function asEngineOperations(operations: Array<Record<string, unknown>>): LookupOperation[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored specs are structural; the engine's addressing reads ids and kinds only.
  return operations as unknown as LookupOperation[];
}

/** Adapts one stored entry row as an engine record, injecting the geometry pointer when the publish needs it. */
export function publishRecordOf(
  entry: { data: unknown; geometryId?: string | null },
  injectGeometry: boolean,
): Record<string, unknown> {
  const data = isRecord(entry.data) ? entry.data : {};
  if (!injectGeometry || typeof entry.geometryId !== "string") {
    return { ...data };
  }
  return { ...data, [PUBLISH_GEOMETRY_COLUMN]: entry.geometryId };
}

/** The stored operations array as plain records, read structurally. */
function operationsOf(spec: Record<string, unknown>): Array<Record<string, unknown>> {
  const operations = spec.operations;
  if (!Array.isArray(operations)) {
    return [];
  }
  return operations.filter(isRecord);
}

/**
 * The rows of one dataset reference: another registry spec's execution, or
 * the pre-loaded component rows. Unknown ids are a load error — the
 * orchestrator loads every dependency the health walk approved.
 */
function rowsOfReference(
  id: string,
  tables: PublishSourceTables,
  visited: Set<string>,
): Array<Record<string, unknown>> {
  const nestedSpec = tables.specByDatasetId.get(id);
  if (nestedSpec !== undefined) {
    return executeInternal(nestedSpec, tables, visited).rows;
  }
  const loaded = tables.rowsByDatasetId.get(id);
  if (loaded === undefined) {
    throw new PublishSpecError(`Dataset "${id}" was not loaded for this publish.`);
  }
  return [...loaded];
}

/** The stored operation record as the engine's shape — the engine validates what it reads. */
function asEngineLookup(operation: Record<string, unknown>): LookupOperation {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored operations are structurally the engine's shapes; the save gate checked what it could.
  return operation as unknown as LookupOperation;
}

/** Rebuilds the pairing after an inner-match lookup dropped rows: the engine itself decides survival. */
function pairingThroughInnerMatch(
  operation: Record<string, unknown>,
  baseRows: readonly Record<string, unknown>[],
  lookupRows: readonly Record<string, unknown>[],
  pairs: unknown[],
): unknown[] {
  const baseKey = typeof operation.baseKey === "string" ? operation.baseKey : "",
    // Throwaway rows carry ONLY the key cell and the original index, so the
    // engine's own match policy decides survival and the index rides the
    // spread into the output — the real pipeline is never polluted.
    synthetic = baseRows.map((row, index) => ({
      __publishIndex: index,
      [baseKey]: baseKey === "" ? undefined : row[baseKey],
    })),
    survivors = applyLookup(asEngineLookup(operation), synthetic, lookupRows);
  return survivors.rows.map((row) => {
    const index = row.__publishIndex;
    return typeof index === "number" ? (pairs[index] ?? null) : null;
  });
}

/**
 * Runs one spec's operations in order (the engine's chained pure calls),
 * returning the final rows and — when the spec carries a resolvable
 * geometrySource naming the injected column — the reference per final row.
 * `visited` is defensive (the save gate rejects cycles); a revisit is
 * rejected rather than looping.
 */
/** The running state of one spec's operation fold. */
interface FoldState {
  pairs: unknown[] | undefined;
  rows: Array<Record<string, unknown>>;
}

/** Applies one rollup operation, refusing one that follows the geometry op. */
function applyRollupOperation(
  operation: Record<string, unknown>,
  state: FoldState,
): void {
  if (state.pairs !== undefined) {
    throw new PublishSpecError(
      "This spec can't be materialized: a rollup follows the geometry operation, and a group spans many rows' geometries.",
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see asEngineLookup; rollup operations are structural too.
  state.rows = applyRollup(operation as unknown as RollupOperation, state.rows).rows;
}

/** Applies one lookup operation, threading the pairing when it follows the geometry op. */
function applyLookupOperation(
  operation: Record<string, unknown>,
  lookupRows: Array<Record<string, unknown>>,
  state: FoldState,
  geometryRule: GeometrySource | undefined,
): void {
  if (state.pairs !== undefined && operation.match === "inner") {
    state.pairs = pairingThroughInnerMatch(operation, state.rows, lookupRows, state.pairs);
  }
  const result = applyLookup(
    asEngineLookup(operation),
    state.rows,
    lookupRows,
    geometryRule,
  );
  state.rows = result.rows;
  if (geometryRule !== undefined) {
    state.pairs = [...(result.geometryReferences ?? [])];
  }
}

/** The validated spec inputs the fold runs on — throws PublishSpecError on every shape it cannot run. */
function specInputsOf(
  spec: unknown,
  tables: PublishSourceTables,
  visited: Set<string>,
): {
  geometryOpIndex: number;
  operations: Array<Record<string, unknown>>;
  rule: GeometrySource | undefined;
  sourceRows: Array<Record<string, unknown>>;
} {
  if (!isRecord(spec)) {
    throw new PublishSpecError("The transform spec must be an object.");
  }
  if (typeof spec.sourceDatasetId !== "string" || spec.sourceDatasetId === "") {
    throw new PublishSpecError("The transform spec does not name its source dataset.");
  }
  if (visited.has(spec.sourceDatasetId) && tables.specByDatasetId.has(spec.sourceDatasetId)) {
    throw new PublishSpecError(
      `Derived dataset "${spec.sourceDatasetId}" is part of a dependency cycle.`,
    );
  }
  visited.add(spec.sourceDatasetId);
  const operations = operationsOf(spec),
    rule = geometryRuleOf(spec);
  return {
    geometryOpIndex: rule === undefined ? -1 : geometryOpIndexOf(operations, rule),
    operations,
    rule,
    sourceRows: rowsOfReference(spec.sourceDatasetId, tables, visited),
  };
}

function executeInternal(
  spec: unknown,
  tables: PublishSourceTables,
  visited: Set<string>,
): FoldState {
  const { geometryOpIndex, operations, rule, sourceRows } = specInputsOf(spec, tables, visited);
  const state: FoldState = { pairs: undefined, rows: sourceRows };

  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "rollup") {
      applyRollupOperation(operation, state);
      continue;
    }
    if (operation.kind !== "lookup") {
      throw new PublishSpecError(
        `Operation ${index} has kind "${String(operation.kind)}", which the publish executor cannot run.`,
      );
    }
    const lookupRows = rowsOfReference(String(operation.lookupDatasetId), tables, visited);
    applyLookupOperation(
      operation,
      lookupRows,
      state,
      index === geometryOpIndex ? rule : undefined,
    );
  }
  return state;
}

/** Resolves one raw reference (a geometry id) to its payload, null when absent or unresolvable. */
function payloadOfReference(
  reference: unknown,
  geometryById: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof reference !== "string") {
    return null;
  }
  const payload = geometryById.get(reference);
  return payload === undefined ? null : payload;
}

/** Removes the injected plumbing key without `delete` (the dynamic-delete ban). */
function stripPlumbingColumn(row: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== PUBLISH_GEOMETRY_COLUMN) {
      stripped[key] = value;
    }
  }
  return stripped;
}

/**
 * Executes a stored spec for publication: final rows (plumbing stripped)
 * plus the geometry payload per row — `null` where the row has none (no
 * rule, unmatched row, absent cell, or a geometry that vanished from the
 * source). The published artifact's geometry rides these payloads into the
 * chunk rows; the component re-validates each against the frozen dataset's
 * type at import time.
 */
export function executeSpecForPublish(
  spec: unknown,
  tables: PublishSourceTables,
): PublishExecution {
  const { pairs, rows } = executeInternal(spec, tables, new Set());
  const geometryPayloads =
    pairs === undefined
      ? rows.map(() => null)
      : pairs.map((reference) => payloadOfReference(reference, tables.geometryById));
  return {
    geometryPayloads,
    rows: needsGeometryPlumbing(spec) ? rows.map(stripPlumbingColumn) : rows,
  };
}

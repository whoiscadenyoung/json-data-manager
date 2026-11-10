/**
 * The pure lookup engine — the v1 half of the transform engine
 * (docs/derived-datasets-design.md §4.1, §6; roadmap issue #94).
 *
 * Contract: `applyLookup(operation, sourceRows, lookupRows)` returns
 * `{ rows, diagnostics }` and never mutates its inputs (§2: one pure
 * engine, two executors, client-side). Rows are generic records — NOT the
 * component's `DatasetEntryRow`; adapting those onto this shape is the
 * row-resolution seam's job. The module imports nothing but the shared
 * coercion utilities: zero app or Convex dependencies.
 *
 * Invariants, each pinned by a test in `lookup.test.ts`:
 *
 * - **Purity.** Input arrays and rows are never written; every output row
 *   is a fresh object, even when nothing is enriched onto it, so callers
 *   can freeze their inputs and feed outputs back in (composition, below).
 * - **Key hygiene is 0.4's, not reinvented here.** Both sides of the join
 *   go through `normalizeKey` (../coercion.ts, written for exactly this
 *   consumer): number `42` and string `"42"` join; strings are trimmed and
 *   case-folded, never numeric-normalized (`"007"` never joins number
 *   `7`); whitespace-only strings, non-finite numbers and every
 *   non-string/number value have no key at all — a keyless row is an
 *   unmatched row, never a crash and never a match against `"null"`.
 * - **Match policy.** "left" (default): every source row survives;
 *   unmatched (and keyless) rows get null for every enrichment field. Row
 *   count is unchanged (§4.1). "inner": unmatched rows are dropped, only
 *   as an explicit spec choice (§6).
 * - **Duplicate-key policy.** §6 demands this be decided, not implicit:
 *   several lookup rows sharing one normalized key resolve per
 *   `onDuplicateKey` — "first" (default) keeps the first, "last" the last,
 *   "error" rejects the whole call with `LookupKeyConflictError`, "collect"
 *   keeps them ALL as per-field arrays (the non-lossy 1-N answer, ADR 0026
 *   / #288 — row count unchanged, unmatched rows still land null).
 * - **Namespacing.** Enrichment lands as `<namespace>.<field>` (default
 *   namespace: the lookup dataset id — see `LookupOperation.namespace`),
 *   so exports and popup labels stay unambiguous (§6). When a base row
 *   already carries a namespaced key, the enrichment wins: the namespace
 *   is the spec author's explicit choice.
 * - **Composition.** Output rows are ordinary records, so the engine
 *   accepts its own output as the next call's input — a derived-of-derived
 *   spec is chained calls. DAG/cycle logic is stage 2's (#95), deliberately
 *   absent here.
 * - **Diagnostics.** `totalSourceRows` is always the input row count, so
 *   matched/total is an unambiguous match rate under both match policies;
 *   `unmatchedKeys` lists the *raw* (pre-normalization), distinct orphan
 *   key values in first-seen order, for the preview's "214 orphan
 *   GrantIds" (§6); `droppedRows` covers the inner-join removals.
 * - **Geometry emission (stage 4, #98 — lifecycle §5.2:134-139).** When the
 *   spec's `geometrySource` rule addresses this operation (addressing is
 *   `geometrySourceOperationOf` (spec.ts) — first lookup op matching the
 *   rule's `lookupDatasetId`, `undefined` when none does; the engine is
 *   per-operation and does not re-verify), the result carries
 *   `geometryReferences`: one value per OUTPUT row, index-paired, read raw
 *   from the rule's side and column — the matched lookup row's cell under
 *   side "lookup" (null for unmatched rows and absent cells), the source
 *   row's own cell under side "base". Chosen over a reserved row key
 *   deliberately: a reserved key collides with schemaless data (the
 *   enrichment-wins rule above) and would leak into exports, while a
 *   parallel array keeps rows clean; stage 5's materialization pairs
 *   references to rows by index when writing geometryIds into published
 *   entries (§5.2). The reference comes from the side's own row — NOT from
 *   the namespaced enrichment — so it resolves even when the op's `fields`
 *   did not pick the geometry column. **References pair with THIS call's
 *   rows only:** a multi-operation spec resolves the rule at the geometry
 *   op's position and consumes THAT call's rows and array — any later
 *   operation that changes row count (e.g. `match: "inner"`, which the
 *   canonical §5.2 two-lookup join chains after it) shifts indices, and no
 *   previously emitted array adjusts (pinned by composition.test.ts's
 *   desync test). Rollup output has no geometry: a group spans many rows,
 *   so `geometrySource` addresses lookup operations only (recorded,
 *   spec.ts).
 */
import { normalizeKey } from "../coercion.js";
import type { GeometrySource, LookupOperation } from "./spec.js";

/**
 * Match-rate diagnostics for one `applyLookup` call — what stage 2's
 * preview renders as "87% of rows matched; 214 orphan GrantIds" (§6).
 */
export interface LookupDiagnostics {
  /** Source rows in — the match-rate denominator under both match policies. */
  totalSourceRows: number;
  /** Source rows that found a lookup row. */
  matchedRows: number;
  /** `totalSourceRows - matchedRows`: rows with no match, or no key at all. */
  unmatchedRows: number;
  /**
   * Distinct raw (pre-normalization) key values of unmatched rows whose key
   * cell is a string or a finite number, in first-seen order — the orphan
   * list a human reads. Strings list exactly as they appear in the data,
   * empty and whitespace-only included; cells with no string or number form
   * (null, NaN, objects, absent) are counted in `unmatchedRows` and
   * contribute nothing here.
   */
  unmatchedKeys: string[];
  /** Rows the match policy removed: `unmatchedRows` under "inner", always 0 under "left". */
  droppedRows: number;
  /**
   * Lookup-side rows that lost the duplicate-key policy ("first" keeps the
   * first row per key, "last" keeps the last — every other row sharing a
   * key drops). 1-N lookups (one award, several corridors) lose rows here
   * silently, so the preview stats surface the count (#282). Always 0
   * under "collect" and "error".
   */
  droppedLookupRows: number;
  /**
   * Lookup-side rows "collect" kept BEYOND each key's first (exactly the
   * rows "first" would drop — the 1-N loss signal, preserved instead:
   * ADR 0026 / #288). Always 0 under the keeping policies and "error", so
   * the preview's stat line can say which policy ran and what it did.
   */
  collectedLookupRows: number;
}

/** The result of one `applyLookup` call: fresh rows plus match-rate diagnostics. */
export interface LookupResult<R extends Record<string, unknown>> {
  /** New rows — never the input row objects, and never the input array. */
  rows: R[];
  diagnostics: LookupDiagnostics;
  /**
   * Present only when a `geometrySource` rule was passed: one geometry
   * reference per row of `rows`, index-paired, resolved from the rule's
   * side and column (see the module doc). Plain serializable values, null
   * where a row has none.
   */
  geometryReferences?: unknown[];
}

/** Thrown when `onDuplicateKey` is "error" and two lookup rows normalize to the same key (§6: decided, not implicit). */
export class LookupKeyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupKeyConflictError";
    Object.setPrototypeOf(this, LookupKeyConflictError.prototype);
  }
}

/**
 * One index entry per normalized lookup key, resolved per the op's
 * duplicate-key policy (§6): "first" keeps the first row per key, "last"
 * overwrites, "error" rejects the whole lookup, "collect" keeps them all
 * (the non-lossy 1-N answer, ADR 0026 — the enrichment turns per-field
 * arrays). Keyless lookup rows are never indexed — they can match nothing,
 * by design.
 */
function buildKeyMap(
  operation: LookupOperation,
  lookupRows: readonly Record<string, unknown>[],
): {
  collectedLookupRows: number;
  droppedLookupRows: number;
  map: Map<string, Record<string, unknown>>;
  /** Populated only under "collect" (ADR 0026); undefined under the other policies. */
  rowsMap: Map<string, Record<string, unknown>[]> | undefined;
} {
  const policy = operation.onDuplicateKey ?? "first",
    byKey = new Map<string, Record<string, unknown>>(),
    // Only populated under "collect" — the keeping policies never consult
    // it, and building both unconditionally would double every index.
    rowsByKey = policy === "collect" ? new Map<string, Record<string, unknown>[]>() : undefined;
  let droppedLookupRows = 0,
    collectedLookupRows = 0;
  for (const row of lookupRows) {
    const key = normalizeKey(row[operation.lookupKey]);
    if (key === undefined) {
      continue;
    }
    if (rowsByKey !== undefined) {
      const bucket = rowsByKey.get(key);
      if (bucket === undefined) {
        rowsByKey.set(key, [row]);
      } else {
        bucket.push(row);
        // The rows beyond each key's first are exactly what "first" would
        // drop — the preserved 1-N loss signal (ADR 0026).
        collectedLookupRows += 1;
      }
      continue;
    }
    const indexed = byKey.get(key);
    if (indexed === undefined) {
      byKey.set(key, row);
      continue;
    }
    if (policy === "error") {
      throw new LookupKeyConflictError(
        `Duplicate key ${JSON.stringify(row[operation.lookupKey])} in lookup dataset "${operation.lookupDatasetId}" (onDuplicateKey: "error").`,
      );
    }
    // Both keeping policies drop the loser: "first" drops this row, "last"
    // drops the one it supersedes. The count is the 1-N loss signal (#282).
    droppedLookupRows += 1;
    if (policy === "last") {
      byKey.set(key, row);
    }
  }
  return { collectedLookupRows, droppedLookupRows, map: byKey, rowsMap: rowsByKey };
}

/**
 * The enrichment field names, in output order: the op's picked fields when
 * given, otherwise every field any lookup row carries except the lookup
 * key, first-seen across the table. Rows are schemaless records, so the
 * union — not one row's keys — is what "all fields" means, and every
 * output row then carries the same namespaced columns (a table, export, or
 * popup never goes ragged).
 */
function enrichmentFields(
  operation: LookupOperation,
  lookupRows: readonly Record<string, unknown>[],
): readonly string[] {
  if (operation.fields !== undefined) {
    return operation.fields;
  }
  const seen = new Set<string>();
  for (const row of lookupRows) {
    for (const field of Object.keys(row)) {
      if (field !== operation.lookupKey) {
        seen.add(field);
      }
    }
  }
  return [...seen];
}

/**
 * The namespaced enrichment for one source row: the matched lookup row's
 * values under `<namespace>.<field>`, or null for every enrichment field
 * when unmatched (§6 "null enriched fields", taken literally). A matched
 * row lacking a picked field also lands as null — the namespaced column
 * set is identical on every row either way. Cells read through
 * `ownCellOf`: rows are schemaless user records, and an inherited property
 * (`constructor`, `toString`) must never enrich a row (#133 item 13).
 */
function enrichmentFor(
  namespace: string,
  fields: readonly string[],
  matched: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const enrichment: Record<string, unknown> = {};
  for (const field of fields) {
    enrichment[`${namespace}.${field}`] = ownCellOf(matched, field);
  }
  return enrichment;
}

/**
 * The namespaced enrichment for one source row under "collect" (ADR 0026):
 * each field lands as an array of the matched rows' values, in lookup-table
 * order. Every match contributes a cell — null when its row lacks the
 * field — so the per-field arrays stay ALIGNED per match (a popup reading
 * `Ns.Corridor_Name[i]` alongside `Ns.Corridor_Status[i]` reads one match).
 * An unmatched row gets null (not an empty array) — the §6 "null enriched
 * fields" literal, same as the keeping policies.
 */
function collectEnrichmentFor(
  namespace: string,
  fields: readonly string[],
  matches: readonly Record<string, unknown>[] | undefined,
): Record<string, unknown> {
  const enrichment: Record<string, unknown> = {};
  for (const field of fields) {
    enrichment[`${namespace}.${field}`] =
      matches === undefined ? null : matches.map((match) => ownCellOf(match, field));
  }
  return enrichment;
}

/** The row's OWN cell under `field`, null when the row is unmatched, lacks it, or only INHERITS it (`Object.hasOwn` — an inherited `constructor` is not data, #133 item 13). */
function ownCellOf(row: Record<string, unknown> | undefined, field: string): unknown {
  if (row === undefined || !Object.hasOwn(row, field)) {
    return null;
  }
  const cell = row[field];
  return cell === undefined ? null : cell;
}

/**
 * The raw key cell as listable orphan text for diagnostics, or `undefined`
 * when it has nothing listable: strings pass through exactly as they
 * appear in the data (pre-normalization, so `" 88 "` lists as `" 88 "`),
 * finite numbers as their decimal form, everything else has no key to list.
 */
function orphanKeyText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/**
 * The geometry reference one output row carries under a `geometrySource`
 * rule, read RAW from the rule's side — a reference is data, not a key, so
 * no normalization applies — with absent cells (and, side "lookup", unmatched
 * rows) resolving to null, never an error. Both sides read own properties
 * only (`ownCellOf`, #133 item 13).
 */
function geometryReferenceOf(
  geometrySource: GeometrySource,
  row: Record<string, unknown>,
  matched: Record<string, unknown> | undefined,
): unknown {
  return ownCellOf(geometrySource.side === "base" ? row : matched, geometrySource.column);
}

/**
 * One source row's matches, resolved per the op's policy: `matches` (the
 * collect bucket) is populated only under "collect", `matched` (the single
 * keeping-policy row, or the collect bucket's FIRST row for the geometry
 * reference) only when something matched. Undefined `matched` = no match.
 */
interface ResolvedMatches {
  matched: Record<string, unknown> | undefined;
  matches: readonly Record<string, unknown>[] | undefined;
}

/** The keeping policies' single-row resolution (buildKeyMap's `map`). */
function keepingMatchOf(
  key: string | undefined,
  byKey: Map<string, Record<string, unknown>>,
): ResolvedMatches {
  const matched = key === undefined ? undefined : byKey.get(key);
  return { matched, matches: undefined };
}

/** The collect policy's bucket resolution (buildKeyMap's `rowsMap`, ADR 0026). */
function collectMatchOf(
  key: string | undefined,
  rowsByKey: Map<string, Record<string, unknown>[]> | undefined,
): ResolvedMatches {
  const matches = key === undefined || rowsByKey === undefined ? undefined : rowsByKey.get(key),
    matched = matches === undefined ? undefined : matches[0];
  return { matched, matches };
}

/** The namespaced enrichment one resolved row gets — collect arrays vs the keeping policies' single cells (ADR 0026). */
function enrichmentOf(
  namespace: string,
  fields: readonly string[],
  resolved: ResolvedMatches,
  collect: boolean,
): Record<string, unknown> {
  return collect
    ? collectEnrichmentFor(namespace, fields, resolved.matches)
    : enrichmentFor(namespace, fields, resolved.matched);
}

/**
 * Applies one lookup operation (§4.1): enrich `sourceRows` with namespaced
 * fields from `lookupRows` — many-to-one, per the op's match, duplicate-key
 * and namespacing policies documented on `LookupOperation` and in the
 * module header. Pass the spec's `geometrySource` rule (when it addresses
 * THIS operation — see the module doc) to also emit per-row geometry
 * references. Inputs are never mutated; every returned row is a fresh
 * object, so the result feeds directly into the next `applyLookup` call of
 * a multi-operation spec. Never throws except the explicit
 * `LookupKeyConflictError`.
 */
export function applyLookup<R extends Record<string, unknown>>(
  operation: LookupOperation,
  sourceRows: readonly R[],
  lookupRows: readonly Record<string, unknown>[],
  geometrySource?: GeometrySource,
): LookupResult<R> {
  const namespace = operation.namespace ?? operation.lookupDatasetId,
    fields = enrichmentFields(operation, lookupRows),
    keyed = buildKeyMap(operation, lookupRows),
    byKey = keyed.map,
    // "collect" (ADR 0026): the non-lossy 1-N policy — every match's fields
    // land as per-field arrays and the row count never changes. The
    // geometry rule reads the FIRST matched row (the references stay
    // one-per-output-row; a collect join wanting a specific match's
    // geometry should use a keeping policy instead).
    collect = keyed.rowsMap !== undefined,
    matchPolicy = operation.match ?? "left",
    geometry = geometrySource,
    references = geometry === undefined ? undefined : ([] as unknown[]),
    rows: R[] = [],
    orphanKeys = new Set<string>();
  const pushReference = (row: R, matched: Record<string, unknown> | undefined): void => {
    if (geometry !== undefined && references !== undefined) {
      references.push(geometryReferenceOf(geometry, row, matched));
    }
  };
  let matchedRows = 0,
    droppedRows = 0;
  for (const row of sourceRows) {
    const rawKey = row[operation.baseKey],
      key = normalizeKey(rawKey),
      { matches, matched } = collect
        ? collectMatchOf(key, keyed.rowsMap)
        : keepingMatchOf(key, byKey);
    if (matched !== undefined) {
      matchedRows += 1;
      rows.push({ ...row, ...enrichmentOf(namespace, fields, { matches, matched }, collect) });
      pushReference(row, matched);
      continue;
    }
    const orphan = orphanKeyText(rawKey);
    if (orphan !== undefined) {
      orphanKeys.add(orphan);
    }
    if (matchPolicy === "inner") {
      droppedRows += 1;
      continue;
    }
    rows.push({
      ...row,
      ...enrichmentOf(namespace, fields, { matched: undefined, matches: undefined }, collect),
    });
    pushReference(row, undefined);
  }
  const result: LookupResult<R> = {
    rows,
    diagnostics: {
      collectedLookupRows: keyed.collectedLookupRows,
      totalSourceRows: sourceRows.length,
      matchedRows,
      unmatchedRows: sourceRows.length - matchedRows,
      unmatchedKeys: [...orphanKeys],
      droppedRows,
      droppedLookupRows: keyed.droppedLookupRows,
    },
  };
  if (references !== undefined) {
    result.geometryReferences = references;
  }
  return result;
}

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
 *   "error" rejects the whole call with `LookupKeyConflictError`.
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
 */
import { normalizeKey } from "../coercion.js";
import type { LookupOperation } from "./spec.js";

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
}

/** The result of one `applyLookup` call: fresh rows plus match-rate diagnostics. */
export interface LookupResult<R extends Record<string, unknown>> {
  /** New rows — never the input row objects, and never the input array. */
  rows: R[];
  diagnostics: LookupDiagnostics;
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
 * overwrites, "error" rejects the whole lookup. Keyless lookup rows are
 * never indexed — they can match nothing, by design.
 */
function buildKeyMap(
  operation: LookupOperation,
  lookupRows: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const policy = operation.onDuplicateKey ?? "first",
    byKey = new Map<string, Record<string, unknown>>();
  for (const row of lookupRows) {
    const key = normalizeKey(row[operation.lookupKey]);
    if (key === undefined) {
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
    if (policy === "last") {
      byKey.set(key, row);
    }
  }
  return byKey;
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
 * set is identical on every row either way.
 */
function enrichmentFor(
  namespace: string,
  fields: readonly string[],
  matched: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const enrichment: Record<string, unknown> = {};
  for (const field of fields) {
    enrichment[`${namespace}.${field}`] = matched === undefined ? null : (matched[field] ?? null);
  }
  return enrichment;
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
 * Applies one lookup operation (§4.1): enrich `sourceRows` with namespaced
 * fields from `lookupRows` — many-to-one, per the op's match, duplicate-key
 * and namespacing policies documented on `LookupOperation` and in the
 * module header. Inputs are never mutated; every returned row is a fresh
 * object, so the result feeds directly into the next `applyLookup` call of
 * a multi-operation spec. Never throws except the explicit
 * `LookupKeyConflictError`.
 */
export function applyLookup<R extends Record<string, unknown>>(
  operation: LookupOperation,
  sourceRows: readonly R[],
  lookupRows: readonly Record<string, unknown>[],
): LookupResult<R> {
  const namespace = operation.namespace ?? operation.lookupDatasetId,
    fields = enrichmentFields(operation, lookupRows),
    byKey = buildKeyMap(operation, lookupRows),
    matchPolicy = operation.match ?? "left",
    rows: R[] = [],
    orphanKeys = new Set<string>();
  let matchedRows = 0,
    droppedRows = 0;
  for (const row of sourceRows) {
    const rawKey = row[operation.baseKey],
      key = normalizeKey(rawKey),
      matched = key === undefined ? undefined : byKey.get(key);
    if (matched !== undefined) {
      matchedRows += 1;
      rows.push({ ...row, ...enrichmentFor(namespace, fields, matched) });
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
    rows.push({ ...row, ...enrichmentFor(namespace, fields, undefined) });
  }
  return {
    rows,
    diagnostics: {
      totalSourceRows: sourceRows.length,
      matchedRows,
      unmatchedRows: sourceRows.length - matchedRows,
      unmatchedKeys: [...orphanKeys],
      droppedRows,
    },
  };
}

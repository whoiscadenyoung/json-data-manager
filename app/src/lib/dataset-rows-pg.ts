import type { Geometry } from "@caden/data-core/geojson";
// The PG edition of the row-resolution seam (design doc §8.3) — React-free
// (`./transform` subpath of data-core only): the tile-archive web worker
// imports this module, so it must never pull a React or convex/react barrel.
// Unlike its Convex sibling (`dataset-rows.ts`), no client is constructed at
// import time either: `sharedClient` resolves lazily, and the worker builds
// its own plain `createClient` instance and passes it via `options.supabase`
// (the cookie-bound browser client is a main-thread object).
import { applyLookup, LookupKeyConflictError } from "@caden/data-core/transform";
import type { LookupOperation } from "@caden/data-core/transform";

import { sharedClient, type StoreOptions } from "#/lib/store/client";
import { listPage, type EntryRow } from "#/lib/store/entries";
import { createGeometrySourceUrl, rowsForTiles, type GeometryRow } from "#/lib/store/geometries";

/**
 * The row-resolution seam, Postgres edition — the one client-side interface
 * for "resolve this dataset's rows (specs applied)" over the Supabase
 * backend. It mirrors the exported API of `dataset-rows.ts` (the Convex
 * edition, which stays in-tree and keeps serving the frozen Convex datasets
 * until their surface migrates — design doc §11/§14): the same function
 * names, the same completeness semantics, the spec-application step copied
 * UNCHANGED so the popup executor's pinned semantics cannot drift.
 *
 * What changed with the backend:
 *   - ids are uuids and rows come from the store modules (`#/lib/store/*`);
 *     the Convex `_id`/`_creationTime` fields do not exist. Entry rows are
 *     keyed by `id`, geometry rows by `entryId` (1:1 — the key
 *     `dataset_rows_for_tiles` hands back).
 *   - pages chain on `nextCursor`, and `nextCursor === null` is `isDone`
 *     (design §5 intro: "every RPC that pages returns next_cursor, null =
 *     exhausted"). The Convex byte budgets that shaped the old page sizes
 *     (`GEOMETRY_PAGE_BYTE_BUDGET`, the 16 MiB execution cap, the
 *     8192-element array cap) do not exist in Postgres, so the one-shot
 *     page sizes rise.
 *   - `entryOrder` keeps its role (the group export's ascending
 *     byte-identity contract) and maps onto the same keyset read.
 *
 * The spec-application step stays INSIDE these functions — no consumer
 * paginates on its own, exactly as before.
 */

/** One entry row, as `entries.listPage` pages it (see `#/lib/store/entries`). */
export type DatasetEntryRow = EntryRow;

/** One geometry row, as `rowsForTiles` pages it (see `#/lib/store/geometries`). */
export type DatasetGeometryRow = GeometryRow;

/**
 * Rows per reactive entries page. In the persisted light-state query hash
 * (see `useDatasetEntryPages`) — never change it per call site. Unchanged
 * from the Convex edition: the reactive layer's page width, not a budget.
 */
export const ENTRIES_PAGE_SIZE = 200;

/**
 * Rows per page for the imperative all-rows reads (exports, prefill): a
 * one-shot stream never renders mid-way, so it pages more densely than the
 * table's persisted per-cursor queries. The Convex server-side clamp that
 * capped this at 500 (`MAX_ENTRY_PAGE_ROWS`) does not exist here; 500 stays
 * because entries pages are cheap round-trips and the burst size is
 * HTTP-shaped, not budget-shaped.
 */
export const ENTRIES_FETCH_PAGE_SIZE = 500;

/**
 * Rows requested per geometry page. Raised from the Convex edition's 500:
 * the component's byte-budget clamp (`GEOMETRY_PAGE_BYTE_BUDGET`) was the
 * real bound — Postgres has no per-execution read cap, and
 * `dataset_rows_for_tiles`' own default is 5000 (design §5.5). This bounds
 * round-trip count, nothing else.
 */
export const GEOMETRY_PAGE_ROWS = 2000;

// ---------------------------------------------------------------------------
// The spec-application step — copied UNCHANGED from `dataset-rows.ts` (pure
// functions over row shapes; the popup executor's semantics are pinned by
// `dataset-rows.test.ts` and must not drift)
// ---------------------------------------------------------------------------

/**
 * `row.data` as the pure engine's generic record — `{}` when the entry
 * carries no object (the engine is record-shaped; lookup.ts's module doc:
 * "adapting those onto this shape is the row-resolution seam's job"). The
 * enrichment side of the popup executor builds its lookup tables through
 * this, so entries and lookup rows adapt in exactly one place.
 */
export function entryDataRecord(row: DatasetEntryRow): Record<string, unknown> {
  return isRecordShaped(row.data) ? row.data : {};
}

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The well-formed lookup operations of one STORED spec, read structurally
 * (the derivedSpec.ts `TransformSpecLike` rule): only `kind: "lookup"`
 * operations whose required columns are non-empty strings survive; unknown
 * operation kinds (stage 4's rollup/geometrySource) and malformed operations
 * contribute nothing instead of breaking the read — storage is `v.any()` and
 * must stay readable across everything any stage stores. An optional cell
 * (`fields`, `namespace`, `match`, `onDuplicateKey`) that is ABSENT passes
 * as the engine default; one that is PRESENT but malformed skips the whole
 * operation — the reader declines to guess.
 */
export function lookupOperationsOfSpec(spec: unknown): readonly LookupOperation[] {
  if (!isRecordShaped(spec) || !Array.isArray(spec.operations)) {
    return [];
  }
  const operations: LookupOperation[] = [];
  for (const stored of spec.operations) {
    const operation = lookupOperationOf(stored);
    if (operation !== undefined) {
      operations.push(operation);
    }
  }
  return operations;
}

/** The lookup match policies the engine accepts (spec.ts). */
const LOOKUP_MATCH_POLICIES = ["left", "inner"] as const;

/** The duplicate-key policies the engine accepts (spec.ts). */
const LOOKUP_DUPLICATE_POLICIES = ["first", "last", "error", "collect"] as const;

/** `value` when it is a non-empty string — the required-column shape the save gate enforces. */
function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `value` when it is one of `literals`, else nothing (the engine's default applies). */
function literalOrUndefined<T extends string>(
  value: unknown,
  literals: readonly T[],
): T | undefined {
  return literals.find((literal) => literal === value);
}

/** True when `cell` is present but its parsed form rejected it — a present-but-malformed optional cell, which skips the whole operation (the reader declines to guess). */
function rejectedOptionalCell(cell: unknown, parsed: unknown): boolean {
  return cell !== undefined && parsed === undefined;
}

/** One stored operation record as the engine's typed shape, or nothing when it isn't a runnable lookup. */
function lookupOperationOf(stored: unknown): LookupOperation | undefined {
  if (!isRecordShaped(stored) || stored.kind !== "lookup") {
    return undefined;
  }
  const baseKey = requiredString(stored.baseKey),
    lookupKey = requiredString(stored.lookupKey),
    lookupDatasetId = requiredString(stored.lookupDatasetId);
  if (baseKey === undefined || lookupKey === undefined || lookupDatasetId === undefined) {
    return undefined;
  }
  // Every optional cell must be well-formed when present — malformed
  // `fields`, `namespace`, `match` or `onDuplicateKey` skips the operation
  // rather than quietly falling back to the engine default (the save gate
  // already rejects these; runtime tolerance just declines to guess).
  const fields = stringArrayOrUndefined(stored.fields),
    match = literalOrUndefined(stored.match, LOOKUP_MATCH_POLICIES),
    namespace = requiredString(stored.namespace),
    onDuplicateKey = literalOrUndefined(stored.onDuplicateKey, LOOKUP_DUPLICATE_POLICIES);
  if (
    rejectedOptionalCell(stored.fields, fields) ||
    rejectedOptionalCell(stored.match, match) ||
    rejectedOptionalCell(stored.namespace, namespace) ||
    rejectedOptionalCell(stored.onDuplicateKey, onDuplicateKey)
  ) {
    return undefined;
  }
  return {
    kind: "lookup",
    baseKey,
    lookupDatasetId,
    lookupKey,
    fields,
    match,
    namespace,
    onDuplicateKey,
  };
}

/** `value` as a string array, or nothing when any element isn't a string (malformed, not filtered). */
function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields: string[] = [];
  for (const field of value) {
    if (typeof field !== "string") {
      return undefined;
    }
    fields.push(field);
  }
  return fields;
}

/**
 * The seam's spec-application step for entry rows. Derived-dataset transform
 * specs (docs/derived-datasets-design.md §5) apply here — every bulk page
 * routes through this, so specs land without touching a single consumer.
 * Bulk enrichment is stage 3a's (#96): identity until it lands.
 *
 * Seam-internal (exported only for the reactive layer); consumers receive
 * specs-applied rows automatically and must never call these directly.
 */
export function applyEntryRowSpecs(rows: DatasetEntryRow[]): DatasetEntryRow[] {
  return rows;
}

/**
 * The point-read half of the spec-application step — §5's popup executor
 * (issue #97, decided as mechanism (b): client-side enrichment, see the
 * addendum in docs/decisions/0005-derived-datasets-catalog-level.md). Folds
 * the stage 1 engine over this one entry's `data` with the given saved
 * specs, joining each operation's side from `lookupRowsByDataset` (records
 * from `entryDataRecord`, keyed by dataset id).
 *
 * Semantics, each pinned by a test in `dataset-rows.test.ts` (and mirrored
 * for the PG rows in `dataset-rows-pg.test.ts`):
 * - **Identity without work.** No specs (or a non-record `data`, which can
 *   hold no join key and must not be silently replaced) returns the row
 *   UNTOUCHED — same reference — so unenriched datasets pay nothing and the
 *   off-path stays byte-identical.
 * - **Fold, in spec order.** Each spec's operations apply in order, each
 *   consuming the previous result (the TransformPreview pattern); later
 *   enrichment wins same-named keys, per the engine.
 * - **A side that hasn't streamed skips its operation.** An absent
 *   `lookupRowsByDataset` entry means the read is still in flight — the
 *   caller (the reactive layer) gates on completeness instead of letting a
 *   half-loaded table fabricate all-null fields.
 * - **A popup is never dropped and never throws.** An inner-match miss
 *   leaves the base row (the bulk path drops it; a popup cannot disappear),
 *   and an `onDuplicateKey: "error"` conflict skips just that operation —
 *   issue #97: "never an error, never a dropped popup".
 *
 * Seam-internal, as above.
 */
export function applyEntryRowSpec(
  row: DatasetEntryRow,
  specs: readonly unknown[] = [],
  lookupRowsByDataset: ReadonlyMap<string, readonly Record<string, unknown>[]> = new Map(),
): DatasetEntryRow {
  if (specs.length === 0 || !isRecordShaped(row.data)) {
    return row;
  }
  let data = row.data,
    applied = false;
  for (const spec of specs) {
    for (const operation of lookupOperationsOfSpec(spec)) {
      const next = applyLookupOperation(operation, data, lookupRowsByDataset);
      if (next !== undefined) {
        data = next;
        applied = true;
      }
    }
  }
  return applied ? { ...row, data } : row;
}

/** One operation's enrichment of `data`, or nothing when its side hasn't streamed or its duplicate-key policy rejected the table. */
function applyLookupOperation(
  operation: LookupOperation,
  data: Record<string, unknown>,
  lookupRowsByDataset: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): Record<string, unknown> | undefined {
  const lookupRows = lookupRowsByDataset.get(operation.lookupDatasetId);
  if (lookupRows === undefined) {
    return undefined;
  }
  try {
    return applyLookup(operation, [data], lookupRows).rows[0];
  } catch (error) {
    if (!(error instanceof LookupKeyConflictError)) {
      throw error;
    }
    // The operation's duplicate-key policy rejected the lookup table —
    // it enriches nothing; the popup keeps the row it had.
    return undefined;
  }
}

/**
 * The geometry-row counterpart of `applyEntryRowSpecs` (e.g. a future
 * `geometrySource` spec reshapes these). Identity until specs exist.
 * Seam-internal, as above.
 */
export function applyGeometryRowSpecs(rows: DatasetGeometryRow[]): DatasetGeometryRow[] {
  return rows;
}

/**
 * The point-read counterpart of `applyGeometryRowSpecs` — so an entry's
 * on-demand geometry row (entry details, edit-panel prefill) takes the same
 * spec pass as the map's bulk rows instead of diverging once specs land.
 * Identity until specs exist. Seam-internal, as above.
 */
export function applyGeometryRowSpec(row: DatasetGeometryRow): DatasetGeometryRow {
  return row;
}

// ---------------------------------------------------------------------------
// The imperative one-shot client (main thread)
// ---------------------------------------------------------------------------

/**
 * The shared imperative client — the browser supabase instance. Exported for
 * parity with the Convex seam (and for the eventual publish orchestrator);
 * every other consumer goes through the read functions. Auth rides the
 * session cookies the provider keeps fresh — there is no token-fetch pause
 * dance to re-create (design §8.3).
 */
export { sharedClient };

/**
 * Options for the imperative reads: pass `supabase` to run on a specific
 * client (the tile-archive worker passes its own, built with plain
 * `createClient` — the cookie-bound browser client is main-thread);
 * defaults to the shared main-thread client. `entryOrder` picks the entries
 * page direction — the table's newest-first default ("desc") or the
 * ascending scan callers whose pre-seam read was the ascending index scan
 * need for byte-identical output (the group export, 3a).
 */
export interface DatasetRowsOptions extends StoreOptions {
  entryOrder?: "asc" | "desc";
  /**
   * Explicit page width for the geometry paging reads (the worker-side
   * take-sizing, #183): the callers that know the dataset's
   * `maxGeometryRowBytes` size the take so one page's payload stays
   * bounded; absent keeps `GEOMETRY_PAGE_ROWS`.
   */
  geometryPageRows?: number;
}

// ---------------------------------------------------------------------------
// Bulk path — entries ("resolve this dataset's entry rows")
// ---------------------------------------------------------------------------

/**
 * Pages `entries.listPage` to exhaustion — the imperative all-rows read the
 * export dialog needs (it writes one file containing the whole dataset) —
 * handing each page (specs applied) to `onPage` as it lands. Sequential:
 * each page resumes from the previous page's cursor. Not a hook: a large
 * dataset's full row set should never become a standing subscription.
 */
export async function forEachDatasetEntryPage(
  datasetId: string,
  onPage: (rows: DatasetEntryRow[]) => void,
  options?: DatasetRowsOptions,
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page = await listPage(
      {
        cursor,
        datasetId,
        numItems: ENTRIES_FETCH_PAGE_SIZE,
        order: options === undefined ? undefined : options.entryOrder,
      },
      options,
    );
    onPage(applyEntryRowSpecs(page.rows));
    if (page.nextCursor === null) {
      return;
    }
    cursor = page.nextCursor;
  }
}

/**
 * Materializes the dataset's full entry row set (specs applied) —
 * `forEachDatasetEntryPage` accumulated. The export's whole-dataset read.
 * `options.entryOrder` preserves each dialog's pre-seam row order (the
 * dataset dialog streams newest-first since the seam landed, 0.2; the group
 * dialog's pre-3a read was the ascending scan, so it asks for "asc").
 */
export async function fetchDatasetEntryRows(
  datasetId: string,
  options?: DatasetRowsOptions,
): Promise<DatasetEntryRow[]> {
  const rows: DatasetEntryRow[] = [];
  await forEachDatasetEntryPage(
    datasetId,
    (page) => {
      rows.push(...page);
    },
    options,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Bulk path — geometries ("resolve this dataset's geometry rows")
// ---------------------------------------------------------------------------

/**
 * Pages `dataset_rows_for_tiles` to exhaustion (design §5.5 — the tile
 * worker's feed), handing each page (specs applied) to `onPage` as it lands
 * — the same completeness loop `useAllPaginated` rode reactively,
 * imperative. Sequential pages resume from the previous cursor;
 * `nextCursor === null` is done.
 */
export async function forEachDatasetGeometryPage(
  datasetId: string,
  onPage: (rows: DatasetGeometryRow[]) => void,
  options?: DatasetRowsOptions,
): Promise<void> {
  const pageRows =
    (options === undefined ? undefined : options.geometryPageRows) ?? GEOMETRY_PAGE_ROWS;
  let cursor: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page = await rowsForTiles({ cursor, datasetId, limit: pageRows }, options);
    onPage(applyGeometryRowSpecs(page.rows));
    if (page.nextCursor === null) {
      return;
    }
    cursor = page.nextCursor;
  }
}

/**
 * Materializes the dataset's full geometry-row set (specs applied) —
 * `forEachDatasetGeometryPage` accumulated. Datasets rendering from tile
 * archives never fetch these reactively (that's the point) — exports and
 * prefill materialize them lazily here, only when the data is actually
 * asked for.
 */
export async function fetchDatasetGeometryRows(
  datasetId: string,
  options?: DatasetRowsOptions,
): Promise<DatasetGeometryRow[]> {
  const rows: DatasetGeometryRow[] = [];
  await forEachDatasetGeometryPage(
    datasetId,
    (page) => {
      rows.push(...page);
    },
    options,
  );
  return rows;
}

async function fetchGeometryPayload(url: string): Promise<Geometry> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch geometry (HTTP ${response.status}).`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a Storage signed URL for a geometry payload, which was validated as a real `Geometry` at write time (import-time validation; the same posture the Convex seam takes).
  return (await response.json()) as Geometry;
}

/**
 * Resolves rows to `Geometry` values keyed by the geometry row's identity —
 * its `entryId` (1:1; the Convex edition keyed by the geometry row's own id,
 * which the PG table shape doesn't surface). Inline rows resolve
 * synchronously from the verbatim `geometry` jsonb; storage-backed rows
 * fetch through a short-lived signed URL (`geometries` bucket, §6) in
 * parallel. A malformed or failed row leaves its geometry unresolved (the
 * export shows `null` geometry) instead of failing the whole export.
 */
export async function resolveGeometryRows(
  rows: DatasetGeometryRow[],
  options?: DatasetRowsOptions,
): Promise<globalThis.Map<string, Geometry>> {
  const client = sharedClientOr(options);
  const resolved = new globalThis.Map<string, Geometry>();
  await Promise.all(
    rows.map(async (row) => {
      try {
        if (row.geometry !== null && row.geometry !== undefined) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- verbatim GeoJSON stored as jsonb, validated at import time (the Convex seam's posture toward its payloads, unchanged).
          resolved.set(row.entryId, row.geometry as Geometry);
        } else if (row.sourcePath !== null && row.sourcePath !== undefined) {
          resolved.set(
            row.entryId,
            await fetchGeometryPayload(await createGeometrySourceUrl(client, row.sourcePath)),
          );
        }
      } catch {
        // Leave this row unresolved; everything else still exports.
      }
    }),
  );
  return resolved;
}

/** The client the resolve pass runs on (the override, else the shared client). */
function sharedClientOr(options: DatasetRowsOptions | undefined) {
  return options !== undefined && options.supabase !== undefined
    ? options.supabase
    : sharedClient();
}

/** One dataset's resolved geometry entries, materialized on demand for an export. */
export async function resolveDatasetGeometryRows(
  datasetId: string,
  options?: DatasetRowsOptions,
): Promise<Array<[string, Geometry]>> {
  return [
    ...(
      await resolveGeometryRows(await fetchDatasetGeometryRows(datasetId, options), options)
    ).entries(),
  ];
}

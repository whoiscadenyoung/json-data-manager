/**
 * The row-resolution seam (roadmap 0.2) — the one client-side interface for
 * "resolve this dataset's rows (draft or published, specs applied)".
 *
 * Every surface that materializes dataset rows resolves them here: the
 * dataset table, both export dialogs, map-layer consumption, the
 * tile-archive worker. No surface drives dataset pagination on its own —
 * the cursor chaining, the page-size constants, and the completeness
 * (`isDone`) semantics all live in this one module, which is what the
 * transform engine (ADR 0005 §10, bulk + popup executors), the surfacing
 * work, and the SQL layer (docs/analysis-layer-design.md §2) will plug into.
 *
 * Today "draft or published" is always the live dataset (the catalog
 * lifecycle, ADR 0008, adds the rest), and the spec-application step below
 * is where derived-dataset transform specs land: the bulk step is still
 * identity (stage 3a, #96), while the point-read step has been the popup
 * executor since 3b (issue #97). Both live INSIDE these functions — no
 * consumer drives a spec or paginates on its own; the popup's one extra
 * obligation is mounting the executor's loaders (see `useEnrichedDatasetEntryRow`),
 * which is what keeps the join subscriptions the seam's.
 *
 * Two row shapes exist:
 *   - entry rows, via `entries.listPage` (row-capped pages, cursor-chained);
 *   - geometry rows, via `geometries.list` (byte-budget pages).
 *
 * The byte budget itself is a SERVER-side clamp inside the component's
 * `listGeometries` (`GEOMETRY_PAGE_BYTE_BUDGET` in
 * `packages/json-cms/src/component/lib.ts`, sized — with its 500-row
 * ceiling — under Convex's ~16 MiB per-execution read cap, which components
 * cannot `.paginate()` under and so must self-clamp). It deliberately does
 * not move here; this module owns only the client-side pagination-driving.
 *
 * This module is React-free: the tile-archive worker paginates from a web
 * worker (passing its own `ConvexClient`). The reactive hooks over this
 * interface — and every `entries.listPage` / `geometries.list` subscription
 * — live in `dataset-rows-react.tsx`.
 */
import type { Geometry } from "@caden/json-cms/react";
// The pure engine, React-free (`./transform` subpath): this module is
// imported by the tile-archive web worker, so it must never pull the
// `@caden/json-cms/react` barrel (react + convex/react + the query bridge)
// into the worker bundle.
import { applyLookup, LookupKeyConflictError } from "@caden/json-cms/transform";
import type { LookupOperation } from "@caden/json-cms/transform";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { env } from "#/env";
import { api } from "#convex/_generated/api";
import { fetchConvexToken } from "#/lib/convex-auth-token";

/** One entry row, as `entries.listPage` pages it. */
export type DatasetEntryRow = FunctionReturnType<typeof api.entries.listPage>["page"][number];

/** One whole `entries.listPage` page (rows + cursor + `isDone`). */
type EntriesPage = FunctionReturnType<typeof api.entries.listPage>;

/** One geometry row, as `geometries.list` paginates it (see the query's doc comment in the component). */
export type DatasetGeometryRow = FunctionReturnType<typeof api.geometries.list>["page"][number];

/**
 * Rows per reactive entries page. In the persisted light-state query hash
 * (see `useDatasetEntryPages`) — never change it per call site.
 */
export const ENTRIES_PAGE_SIZE = 200;

/**
 * Rows per page for the imperative all-rows reads (exports, prefill): a
 * one-shot stream never renders mid-way, so it pages more densely than the
 * table's persisted per-cursor queries. At the component's server-side
 * `MAX_ENTRY_PAGE_ROWS` clamp (packages/json-cms `lib.ts`), so it is honored
 * as asked — raising it requires raising the server clamp too.
 */
export const ENTRIES_FETCH_PAGE_SIZE = 500;

/**
 * Rows requested per geometry page. Mirrors the component's server-side
 * `MAX_GEOMETRY_PAGE_ROWS` clamp — the page byte budget
 * (`GEOMETRY_PAGE_BYTE_BUDGET` in the component's `lib.ts`) actually bounds
 * each page long before this unless every row is tiny, so this only bounds
 * round-trip count.
 */
export const GEOMETRY_PAGE_ROWS = 500;

// ---------------------------------------------------------------------------
// The spec-application step — bulk identity until stage 3a; the point-read
// popup executor (issue #97) since 3b
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
const LOOKUP_DUPLICATE_POLICIES = ["first", "last", "error"] as const;

/** `value` when it is a non-empty string — the required-column shape the save gate enforces. */
function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `value` when it is one of `literals`, else nothing (the engine's default applies). */
function literalOrUndefined<T extends string>(value: unknown, literals: readonly T[]): T | undefined {
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
 * Semantics, each pinned by a test in `dataset-rows.test.ts`:
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

// One shared client for the imperative all-rows reads: exports materialize
// rarely, and `ConvexClient` shares the worker's proven pattern for
// imperative one-shot calls. (Reactive reads ride the app provider's
// ConvexReactClient instead — see `dataset-rows-react.tsx`.) The publish
// orchestrator (`./publish`) rides the same client — one socket for every
// imperative, signed-in flow.
let client: ConvexClient | undefined;

/** The shared imperative client, identity attached. Exported for the publish orchestrator; every other consumer goes through the read functions. */
export function sharedClient(): ConvexClient {
  client ??= new ConvexClient(env.VITE_CONVEX_URL);
  // Identity for the sign-in gate — re-asserted per call so a client first
  // created signed out still authenticates once the session exists.
  client.setAuth(fetchConvexToken);
  return client;
}

/** Options for the imperative reads: pass `convex` to run on a specific client (the tile-archive worker passes its own); defaults to the shared main-thread client. `entryOrder` picks the entries page direction — the table's newest-first default ("desc") or the ascending scan callers whose pre-seam read was `entries.listEntriesForSchemas` need for byte-identical output (the group export, 3a). */
export interface DatasetRowsOptions {
  convex?: ConvexClient;
  entryOrder?: "asc" | "desc";
}

function rowsClient(options: DatasetRowsOptions | undefined): ConvexClient {
  return options === undefined || options.convex === undefined ? sharedClient() : options.convex;
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
  schemaId: string,
  onPage: (rows: DatasetEntryRow[]) => void,
  options?: DatasetRowsOptions,
): Promise<void> {
  const convex = rowsClient(options),
    entryOrder = options === undefined ? undefined : options.entryOrder;
  let cursor: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page: EntriesPage = await convex.query(api.entries.listPage, {
      order: entryOrder,
      paginationOpts: { cursor, numItems: ENTRIES_FETCH_PAGE_SIZE },
      schemaId,
    });
    onPage(applyEntryRowSpecs(page.page));
    if (page.isDone) {
      return;
    }
    cursor = page.continueCursor;
  }
}

/**
 * Materializes the dataset's full entry row set (specs applied) —
 * `forEachDatasetEntryPage` accumulated. The export's whole-dataset read.
 * `options.entryOrder` preserves each dialog's pre-seam row order: the
 * dataset dialog has streamed newest-first since the seam landed (0.2);
 * the group dialog's pre-3a read was the ascending index scan, so it asks
 * for "asc" to keep its untoggled output byte-identical.
 */
export async function fetchDatasetEntryRows(
  schemaId: string,
  options?: DatasetRowsOptions,
): Promise<DatasetEntryRow[]> {
  const rows: DatasetEntryRow[] = [];
  await forEachDatasetEntryPage(
    schemaId,
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
 * Pages `geometries.list` to exhaustion, handing each page (specs applied)
 * to `onPage` as it lands — the same completeness loop `useAllPaginated`
 * rides reactively, imperative. Sequential pages resume from the previous
 * cursor.
 */
export async function forEachDatasetGeometryPage(
  schemaId: string,
  onPage: (rows: DatasetGeometryRow[]) => void,
  options?: DatasetRowsOptions,
): Promise<void> {
  const convex = rowsClient(options);
  let cursor = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page = await convex.query(api.geometries.list, {
      paginationOpts: { cursor, numItems: GEOMETRY_PAGE_ROWS },
      schemaId,
    });
    onPage(applyGeometryRowSpecs(page.page));
    if (page.isDone) break;
    cursor = page.continueCursor;
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
  schemaId: string,
  options?: DatasetRowsOptions,
): Promise<DatasetGeometryRow[]> {
  const rows: DatasetGeometryRow[] = [];
  await forEachDatasetGeometryPage(
    schemaId,
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a Convex storage URL for a geometry payload, which was validated as a real `Geometry` server-side at write time.
  return (await response.json()) as Geometry;
}

/**
 * Resolves rows to `Geometry` values keyed by the geometry row id — the same
 * keying `useResolvedGeometries` produces and `buildGeoJsonCollection`
 * consumes. Inline rows parse synchronously; externally-stored rows fetch in
 * parallel. A malformed or failed row leaves its geometry unresolved (the
 * export shows `null` geometry) instead of failing the whole export.
 */
export async function resolveGeometryRows(
  rows: DatasetGeometryRow[],
): Promise<globalThis.Map<string, Geometry>> {
  const resolved = new globalThis.Map<string, Geometry>();
  await Promise.all(
    rows.map(async (row) => {
      try {
        if (row.geometryJson !== undefined) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated as a real `Geometry` server-side at write time.
          resolved.set(row._id, JSON.parse(row.geometryJson) as Geometry);
        } else if (row.geometryUrl !== undefined) {
          resolved.set(row._id, await fetchGeometryPayload(row.geometryUrl));
        }
      } catch {
        // Leave this row unresolved; everything else still exports.
      }
    }),
  );
  return resolved;
}

/** One dataset's resolved geometry entries, materialized on demand for an export. */
export async function resolveDatasetGeometryRows(
  schemaId: string,
  options?: DatasetRowsOptions,
): Promise<Array<[string, Geometry]>> {
  return [
    ...(await resolveGeometryRows(await fetchDatasetGeometryRows(schemaId, options))).entries(),
  ];
}

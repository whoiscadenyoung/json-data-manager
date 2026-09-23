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
 * is identity — derived-dataset transform specs arrive in stages 1+. Both
 * land INSIDE this module; consumers never learn about either.
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
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { env } from "#/env";
import { api } from "#convex/_generated/api";

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
// The spec-application step — identity until stage 1+
// ---------------------------------------------------------------------------

/**
 * The seam's spec-application step for entry rows. Derived-dataset transform
 * specs (docs/derived-datasets-design.md §5) apply here — every bulk page
 * and point read routes through these stubs, so specs land without touching
 * a single consumer. Identity until specs exist.
 *
 * Seam-internal (exported only for the reactive layer); consumers receive
 * specs-applied rows automatically and must never call these directly.
 */
export function applyEntryRowSpecs(rows: DatasetEntryRow[]): DatasetEntryRow[] {
  return rows;
}

/**
 * The point-read (popup-path) counterpart of `applyEntryRowSpecs` — §5's
 * on-demand lookup executor (merge related rows into one clicked entry)
 * plugs in here. Identity until specs exist. Seam-internal, as above.
 */
export function applyEntryRowSpec(row: DatasetEntryRow): DatasetEntryRow {
  return row;
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
// ConvexReactClient instead — see `dataset-rows-react.tsx`.)
let client: ConvexClient | undefined;

function sharedClient(): ConvexClient {
  client ??= new ConvexClient(env.VITE_CONVEX_URL);
  return client;
}

/** Options for the imperative reads: pass `convex` to run on a specific client (the tile-archive worker passes its own); defaults to the shared main-thread client. */
export interface DatasetRowsOptions {
  convex?: ConvexClient;
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
  const convex = rowsClient(options);
  let cursor: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page: EntriesPage = await convex.query(api.entries.listPage, {
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

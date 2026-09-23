/**
 * The row-resolution seam's reactive layer (roadmap 0.2) — hooks over
 * `dataset-rows.ts`'s interface for surfaces that SUBSCRIBE to a dataset's
 * rows while rendered: the dataset table's cursor-chained pages, the
 * row-path map's per-schema geometry fan-out, and the on-demand point reads
 * behind map popups, entry panels, and entry details.
 *
 * Split from the core module so the tile-archive worker can share the
 * pagination-driving without importing React. Subscription policy differs
 * by shape, on purpose:
 *   - entry pages go through the `convexQuery` bridge (not convex/react's
 *     `usePaginatedQuery`, which bypasses the TanStack cache) so every page
 *     stays a light-namespaced cache entry — persisted by the part-5 store
 *     and rendered from it on a cold start. That makes `ENTRIES_PAGE_SIZE`
 *     part of the persisted query hash: keep it a stable constant, never a
 *     prop.
 *   - geometry rows ride `useAllPaginated` (plain convex/react
 *     subscriptions — geometry payloads never enter the persisted-state
 *     system, the part-5 invariant).
 *   - point reads ride plain convex/react `useQuery`, subscribed only while
 *     the caller holds them (the #52 popup pattern).
 */
import { useAllPaginated } from "@caden/json-cms/react";
import { convexQuery } from "@convex-dev/react-query";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyEntryRowSpec,
  applyEntryRowSpecs,
  applyGeometryRowSpec,
  applyGeometryRowSpecs,
  ENTRIES_PAGE_SIZE,
  type DatasetEntryRow,
  type DatasetGeometryRow,
} from "#/lib/dataset-rows";
import { api } from "#convex/_generated/api";

type EntriesPage = FunctionReturnType<typeof api.entries.listPage>;
type EntriesPageResult = UseQueryResult<EntriesPage>;

function pageQuery(schemaId: string, cursor: string | null) {
  return convexQuery(api.entries.listPage, {
    paginationOpts: { cursor, numItems: ENTRIES_PAGE_SIZE },
    schemaId,
  });
}

/** The cursors to subscribe for `schemaId` — a fresh chain when the dataset
 * changed under a still-mounted hook (same route component, new param). */
function activeCursors(
  chain: { cursors: Array<string | null>; schemaId: string },
  schemaId: string,
): Array<string | null> {
  return chain.schemaId === schemaId ? chain.cursors : [null];
}

/** Appends the next cursor once the last page has resolved; idempotent under
 * repeated calls (double clicks, scroll bursts) before React re-renders. */
function appendCursor(
  prev: { cursors: Array<string | null>; schemaId: string },
  schemaId: string,
  prevChainLength: number,
  continueCursor: string,
): { cursors: Array<string | null>; schemaId: string } {
  const active = activeCursors(prev, schemaId);
  if (active.length !== prevChainLength || active[active.length - 1] === continueCursor) {
    return prev;
  }
  return { cursors: [...active, continueCursor], schemaId };
}

/** One query slot's page data, or undefined while pending/unmounted. */
function pageData(result: EntriesPageResult | undefined): EntriesPage | undefined {
  return result === undefined ? undefined : result.data;
}

/** One query slot's rows, or none while pending. */
function pageRows(result: EntriesPageResult): DatasetEntryRow[] {
  const data = pageData(result);
  return data === undefined ? [] : data.page;
}

/** Page gate: true only while the FIRST page is pending — later pages stream
 * in below the fold and must never blank the page. */
function isLoadingFirstPage(results: Array<EntriesPageResult>): boolean {
  const first = results[0];
  return first === undefined ? true : first.isLoading;
}

/** True while a load-more page beyond the first is in flight. */
function isLoadingMorePages(results: Array<EntriesPageResult>, chainLength: number): boolean {
  const last = results[chainLength - 1];
  return chainLength > 1 && last !== undefined && last.isLoading;
}

/**
 * The dataset's entry rows (specs applied) as a growing set of cursor-chained
 * server pages. `loadMore` (wired to the table's scroll-near-end and its
 * Load-more button) appends the next cursor once the last page has resolved;
 * repeated calls before that are no-ops, so bursty scroll events can't
 * duplicate a page.
 */
export function useDatasetEntryPages(schemaId: string) {
  // Keyed on schemaId so navigating between datasets restarts the chain
  // instead of replaying the old dataset's cursors against the new one.
  const [chain, setChain] = useState<{ cursors: Array<string | null>; schemaId: string }>({
    cursors: [null],
    schemaId,
  });
  const cursors = activeCursors(chain, schemaId);

  const results = useQueries({
    queries: useMemo(
      () => cursors.map((cursor) => pageQuery(schemaId, cursor)),
      [cursors, schemaId],
    ),
  });

  const lastPage = pageData(results[cursors.length - 1]);

  const loadMore = useCallback(() => {
    if (lastPage === undefined || lastPage.isDone) {
      return;
    }
    setChain((prev) => appendCursor(prev, schemaId, cursors.length, lastPage.continueCursor));
  }, [cursors.length, lastPage, schemaId]);

  const entries = useMemo(() => applyEntryRowSpecs(results.flatMap(pageRows)), [results]);

  return {
    entries,
    isLoading: isLoadingFirstPage(results),
    isLoadingMore: isLoadingMorePages(results, cursors.length),
    isComplete: lastPage !== undefined && lastPage.isDone,
    canLoadMore: lastPage !== undefined && !lastPage.isDone,
    loadMore,
  };
}

/**
 * One dataset's geometry rows for the row-path map, fetched every page —
 * see `useAllPaginated`. `enabled` gates the fetch without unmounting the
 * hook (the dataset page holds it off while a fresh tile archive is serving
 * the map — issue #58 part 4 — and while the source decision is pending).
 *
 * `geometryRows` is `undefined` only until the first rows exist;
 * `isComplete` is the real "everything is loaded" signal — a full pagination
 * pass has finished (`status === "Exhausted"`), so the array is the complete
 * dataset. (`isLoading` alone drops back to false after the first page,
 * which is why a skeleton gate must key off `isComplete`.)
 */
export function useDatasetGeometryRows(
  schemaId: string,
  enabled: boolean,
): {
  geometryRows: DatasetGeometryRow[] | undefined;
  isComplete: boolean;
} {
  const { isLoading, results, status } = useAllPaginated(
    api.geometries.list,
    enabled ? { schemaId } : "skip",
  );
  // Spec application memoized like the entry path below: identity today, but
  // a real §5-style transform must run once per page arrival, not per render.
  const geometryRows = useMemo(
    () => (isLoading ? undefined : applyGeometryRowSpecs(results)),
    [isLoading, results],
  );
  return {
    geometryRows,
    isComplete: status === "Exhausted",
  };
}

/**
 * One entry row, read on demand — the seam's point-read path (issue #52's
 * popup pattern: one indexed single-doc subscription, live only while the
 * caller holds it; closing drops it). `undefined` id subscribes to nothing;
 * the read itself is `undefined` while in flight and `null` when the entry
 * is gone. Rows come back specs applied — the popup executor's merge point.
 */
export function useDatasetEntryRow(
  entryId: string | undefined,
): DatasetEntryRow | null | undefined {
  const entry = useQuery(api.entries.get, entryId === undefined ? "skip" : { entryId });
  return entry === undefined || entry === null ? entry : applyEntryRowSpec(entry);
}

/**
 * The one geometry row attached to an entry (1:1), read on demand — the
 * single-row counterpart of the bulk geometry path, so an entry-level view
 * (edit-panel prefill on the tile path, entry details) never drags in the
 * dataset's paginated set. `undefined` id subscribes to nothing; the read
 * is `undefined` while in flight and `null` when the entry has no geometry.
 */
export function useDatasetEntryGeometryRow(
  entryId: string | undefined,
): DatasetGeometryRow | null | undefined {
  const row = useQuery(
    api.geometries.getEntryGeometry,
    entryId === undefined ? "skip" : { entryId },
  );
  return row === undefined || row === null ? row : applyGeometryRowSpec(row);
}

/**
 * One schema's live geometry-loading state, as `SchemaGeometriesLoader`
 * reports it: `rows` are the pages fetched so far (growing as the pass
 * streams, final once `complete`), and `complete` is true only after a FULL
 * pagination pass — `status === "Exhausted"`.
 */
export interface SchemaGeometriesReport {
  complete: boolean;
  rows: DatasetGeometryRow[];
}

/**
 * Loads one schema's geometries (every page — see `useAllPaginated`) and
 * reports progress up via `onLoaded` as it arrives. Renders nothing.
 *
 * Two things travel in the report, on purpose: partial `rows` stream up as
 * each page lands (a consumer that renders them as they arrive gets the
 * incremental feature-by-feature fill), while `complete` only flips after a
 * full pass — `useAllPaginated`'s `isLoading` drops after the FIRST page,
 * and a completeness gate keyed on it would latch after one round trip
 * while the remaining pages were still streaming. `complete` latches on
 * the first finished pass: a live re-read flips `status` back while
 * `useAllPaginated` keeps serving the last complete snapshot, so the
 * loader keeps reporting that snapshot (still `complete`) instead of
 * flickering back — which is what lets a mounted map stay mounted and a
 * hidden chip stay hidden across background re-reads.
 *
 * There is no server-side "all geometries in these schemas" query: Convex
 * allows at most one `.paginate()` call per query execution, and geometries
 * are spread across several independently indexed schemas, so aggregating
 * them server-side isn't possible without a denormalized `schemaId` fan-out
 * on every `geometries` row. Rendering one of these per schema — each with
 * its own stable `useAllPaginated` hook call — is the supported way to fan
 * out N independent reactive queries in React; a loop calling hooks inside
 * one component is not.
 */
export function SchemaGeometriesLoader({
  schemaId,
  onLoaded,
}: {
  schemaId: string;
  onLoaded: (schemaId: string, report: SchemaGeometriesReport | undefined) => void;
}) {
  const { results, status } = useAllPaginated(api.geometries.list, { schemaId }),
    completedRef = useRef(false),
    // Applied once per page arrival, not per effect fire: the fan-out's
    // bail-out dedupes on row reference (`existing.rows === report.rows`),
    // which a real spec transform (fresh array per call) would otherwise
    // defeat into a setState loop.
    specRows = useMemo(() => applyGeometryRowSpecs(results), [results]);
  useEffect(() => {
    if (status === "Exhausted") {
      completedRef.current = true;
    }
    onLoaded(schemaId, { complete: completedRef.current, rows: specRows });
  }, [schemaId, status, specRows, onLoaded]);
  return null;
}

/**
 * Fan-out loader for several schemas' geometries: mounts one
 * `SchemaGeometriesLoader` per schema and merges the results.
 *
 * Returns `loaders` (render them alongside your UI — they must stay mounted
 * even while loading, since they're what's fetching the data), `geometries`,
 * which is `undefined` until every schema's pagination has completed at
 * least one full pass (the "everything is loaded" signal), and
 * `servedGeometries`, which streams each schema's rows AS THEIR PAGES
 * ARRIVE — partial mid-pass rows included — so a consumer renders features
 * incrementally while they load instead of waiting for a dataset's whole
 * pass (only `undefined` before any schema has fetched any rows). A
 * consumer that keeps rendering with `servedGeometries` keeps its mounted
 * state (e.g. a Map's camera) across layer changes and background re-reads.
 */
export function useGeometriesBySchemas(schemaIds: string[]): {
  geometries: DatasetGeometryRow[] | undefined;
  servedGeometries: DatasetGeometryRow[] | undefined;
  loaders: React.ReactNode[];
} {
  const [reportsBySchema, setReportsBySchema] = useState<
      globalThis.Map<string, SchemaGeometriesReport | undefined>
    >(() => new globalThis.Map()),
    // Must be reference-stable across renders (hence `useCallback` with an
    // empty dep array — the body only closes over the stable `useState`
    // setter): `SchemaGeometriesLoader` depends on `onLoaded` inside its own
    // `useEffect`, so a fresh function identity here on every render would
    // re-fire that effect every time regardless of whether the underlying
    // geometries actually changed, cascading into a `setState`-in-`useEffect`
    // loop across every mounted loader ("Maximum update depth exceeded").
    handleGeometriesLoaded = useCallback(
      (schemaId: string, report: SchemaGeometriesReport | undefined) => {
        setReportsBySchema((prev) => {
          const existing = prev.get(schemaId);
          // Bail out of the update entirely when nothing changed (covers the
          // common case of an effect re-firing for the same status phase):
          // `new Map(prev)` always returns a new reference, so skipping it
          // here is what actually breaks the loop, not just
          // `handleGeometriesLoaded`'s own identity.
          if (
            existing === report ||
            (existing !== undefined &&
              report !== undefined &&
              existing.complete === report.complete &&
              existing.rows === report.rows)
          ) {
            return prev;
          }
          return new globalThis.Map(prev).set(schemaId, report);
        });
      },
      // `setReportsBySchema` is a useState setter — stable for the
      // component's lifetime, so the callback identity is too.
      [setReportsBySchema],
    );

  // Report readers — the repo's oxlint bans optional chaining, and the map
  // lookups repeat across the derived values below.
  const completeFor = (schemaId: string) => {
      const report = reportsBySchema.get(schemaId);
      return report !== undefined && report.complete;
    },
    rowsFor = (schemaId: string) => {
      const report = reportsBySchema.get(schemaId);
      return report === undefined ? [] : report.rows;
    },
    allComplete = schemaIds.every(completeFor),
    geometries = allComplete ? schemaIds.flatMap(rowsFor) : undefined,
    anyRows = schemaIds.some((schemaId) => rowsFor(schemaId).length > 0),
    servedGeometries = anyRows ? schemaIds.flatMap(rowsFor) : undefined;

  return {
    geometries,
    servedGeometries,
    loaders: schemaIds.map((schemaId) => (
      <SchemaGeometriesLoader
        key={schemaId}
        schemaId={schemaId}
        onLoaded={handleGeometriesLoaded}
      />
    )),
  };
}

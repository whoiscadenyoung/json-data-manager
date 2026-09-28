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
 *   - the popup executor's lookup sides (issue #97) ride `useAllPaginated`
 *     over the entry bulk path — plain convex/react subscriptions like the
 *     geometry rows, never persisted: they are live only while a popup is
 *     open, so a map's first paint and a closed popup pay nothing for
 *     joins.
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
  entryDataRecord,
  lookupOperationsOfSpec,
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
 * is gone. Rows come back BASE-only: bulk spec application is still
 * identity (stage 3a, #96), and the popup executor enriches one layer up in
 * `useEnrichedDatasetEntryRow` — this hook is that executor's entry-read
 * substrate, and the point read every other surface (entry details, edit
 * prefill) uses until enrichment is surfaced there.
 */
export function useDatasetEntryRow(
  entryId: string | undefined,
): DatasetEntryRow | null | undefined {
  const entry = useQuery(api.entries.get, entryId === undefined ? "skip" : { entryId });
  return entry === undefined || entry === null ? entry : applyEntryRowSpec(entry);
}

/**
 * The map's feature-click payload (layers-map's `FeatureProperties`) as the
 * popup executor's selection shape — kept structural so any surface that
 * clicks a feature can hand the pair straight in.
 */
export interface FeatureSelection {
  entryId: string;
  schemaId: string;
}

/**
 * First-seen distinct lookup dataset ids across the loaded specs — the
 * popup executor's join sides, deduped so the fan-out loads each once.
 */
function lookupDatasetIdsOf(specs: readonly unknown[]): string[] {
  const seen = new Set<string>(),
    ids: string[] = [];
  for (const spec of specs) {
    for (const operation of lookupOperationsOfSpec(spec)) {
      if (!seen.has(operation.lookupDatasetId)) {
        seen.add(operation.lookupDatasetId);
        ids.push(operation.lookupDatasetId);
      }
    }
  }
  return ids;
}

/** The full spec docs one shortlist resolved to: `resolved` is false while any read is in flight; a vanished row (deleted mid-read) simply drops out of `specs`. */
function dataSpecsOf(results: ReadonlyArray<{ data?: unknown }>): {
  resolved: boolean;
  specs: unknown[];
} {
  const resolved = results.every((result) => result.data !== undefined);
  if (!resolved) {
    return { resolved, specs: [] };
  }
  const specs = results.flatMap((result) => {
    const data: unknown = result.data;
    return typeof data === "object" && data !== null && "spec" in data ? [data.spec] : [];
  });
  return { resolved, specs };
}

/**
 * The lookup sides' registry checks (`derivedDatasets.get` answers null for
 * any id that is not a registry row): `resolved` when every side answered,
 * `allComponent` when no side is itself a derived dataset. A registry side
 * has no entry rows to stream — derived datasets are compute-on-read, and
 * only publishing materializes rows — so streaming its id would hang the
 * popup on a never-completing pagination (or worse, present a
 * "ready"-labeled spec's answer as all-null fields). Such sides enrich
 * nothing: the popup renders base-only until stage 4's composition gives
 * derived rows a client-side materializer (ADR 0005 addendum).
 */
function lookupSidesOf(checks: ReadonlyArray<{ data?: unknown }>): {
  resolved: boolean;
  allComponent: boolean;
} {
  const resolved = checks.every((check) => check.data !== undefined);
  return {
    resolved,
    allComponent: resolved && checks.every((check) => check.data === null),
  };
}

/**
 * Each lookup side's rows as the engine's records — keyed by dataset id so
 * a multi-step fold reads its side per operation. A side with no report is
 * left OUT of the map entirely (not mapped to an empty table): a gated
 * registry side never streams, and an absent key is what makes
 * `applyEntryRowSpec` skip its operation instead of joining against an
 * empty table and rendering all-null fields.
 */
function lookupRowsByDatasetOf(
  lookupSchemaIds: readonly string[],
  reportsBySchema: ReadonlyMap<string, SchemaEntriesReport | undefined>,
): ReadonlyMap<string, readonly Record<string, unknown>[]> {
  return new globalThis.Map(
    lookupSchemaIds.flatMap((lookupSchemaId): Array<[string, Array<Record<string, unknown>>]> => {
      const report = reportsBySchema.get(lookupSchemaId);
      return report === undefined ? [] : [[lookupSchemaId, report.rows.map(entryDataRecord)]];
    }),
  );
}

/** True when every lookup side has finished a full pagination pass (a side absent from the reports hasn't). */
function allLookupsComplete(
  lookupSchemaIds: readonly string[],
  reportsBySchema: ReadonlyMap<string, SchemaEntriesReport | undefined>,
): boolean {
  return lookupSchemaIds.every((lookupSchemaId) => {
    const report = reportsBySchema.get(lookupSchemaId);
    return report !== undefined && report.complete;
  });
}

/** The clicked entry with its saved specs folded on — or the untouched entry while nothing can be applied yet. */
function enrichedEntryOf(
  entry: DatasetEntryRow | null | undefined,
  schemaId: string | undefined,
  joinedPending: boolean,
  specs: readonly unknown[],
  lookupRowsByDataset: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): DatasetEntryRow | null | undefined {
  if (entry === null || entry === undefined || schemaId === undefined || joinedPending) {
    return entry;
  }
  return applyEntryRowSpec(entry, specs, lookupRowsByDataset);
}

/**
 * True while the popup executor's spec/lookup reads are still streaming for
 * an active selection. A settled spec whose lookup side is a derived
 * dataset is NOT pending — it enriches nothing (see `lookupSidesOf`), so
 * the popup settles base-only instead of spinning forever.
 */
function joinedPendingOf(
  schemaId: string | undefined,
  specsResolved: boolean,
  sides: { resolved: boolean; allComponent: boolean },
  lookupsComplete: boolean,
): boolean {
  return (
    schemaId !== undefined &&
    (!specsResolved || !sides.resolved || (sides.allComponent && !lookupsComplete))
  );
}

/**
 * The popup executor's composition (issue #97, decided as mechanism (b) —
 * client-side enrichment; see the addendum in
 * docs/decisions/0005-derived-datasets-catalog-level.md): the #52 point
 * read, enriched. `undefined` (no selection) behaves exactly like
 * `useDatasetEntryRow(undefined)`; passing the clicked feature's
 * `{entryId, schemaId}` resolves the SAVED, read-time-healthy specs
 * targeting that dataset (`api.derivedDatasets.listBySource` for the
 * source-keyed shortlist, `get` for each full spec — drafts never surface
 * to catalog consumers, and an orphaned/stale spec would render nulls at
 * best, so neither enriches) and streams each lookup dataset's rows through
 * the seam.
 *
 * Every subscription here is live only while the caller holds the hook with
 * a selection: close the popup and the entry read, the spec reads, and the
 * lookup-row fan-out all drop ("skip"/disabled) — a map's first paint pays
 * nothing for joins, and a popup that opens pays only while it is open, the
 * #52 trade made deliberately and recorded in the ADR addendum.
 *
 * `joinedPending` is true while those reads are still streaming: the caller
 * renders base properties immediately and the namespaced fields arrive
 * reactively. Once applied, an unmatched key carries null for every
 * enrichment field — never an error, never a dropped popup. `loaders` are
 * the seam's per-schema fan-out components — render them alongside the
 * popup (they render nothing themselves); they are what holds the
 * lookup-row subscriptions.
 *
 * Two recorded edges (both in the ADR 0005 addendum): a spec whose lookup
 * side is itself a derived dataset enriches nothing — derived datasets have
 * no entry rows to stream (compute-on-read; only publishing materializes),
 * so the sides are checked against the registry and such specs settle
 * base-only instead of hanging or rendering all-null fields; and a derived
 * layer's feature properties (stage 3a) must carry the DEFINING SPEC'S
 * `sourceDatasetId` as `schemaId` — this hook keys the spec shortlist on
 * it, and `entries.get` then reads the source entry unchanged.
 *
 * Derived values stay plain (`const`) on purpose — oxlint's
 * `react/preserve-manual-memoization` rejects manual `useMemo` whose
 * dependencies come from these live-query results, and plain consts stay
 * lint-clean while remaining correct when the React Compiler is enabled to
 * memoize them (it is not part of this build today; the derivations are
 * cheap and popup-scoped).
 */
export function useEnrichedDatasetEntryRow(selected: FeatureSelection | undefined): {
  entry: DatasetEntryRow | null | undefined;
  joinedPending: boolean;
  loaders: React.ReactNode[];
} {
  const entryId = selected === undefined ? undefined : selected.entryId,
    schemaId = selected === undefined ? undefined : selected.schemaId,
    entry = useDatasetEntryRow(entryId),
    specSummaries = useQuery(
      api.derivedDatasets.listBySource,
      schemaId === undefined ? "skip" : { sourceDatasetId: schemaId },
    ),
    readySpecSummaries =
      specSummaries === undefined
        ? []
        : specSummaries.filter(
            (summary) => summary.status === "saved" && summary.health === "ready",
          ),
    specResults = useQueries({
      queries: readySpecSummaries.map((summary) =>
        convexQuery(api.derivedDatasets.get, { id: summary._id }),
      ),
    }),
    specRead = dataSpecsOf(specResults),
    lookupSchemaIds = lookupDatasetIdsOf(specRead.specs),
    // Each side checked against the registry before streaming: only
    // component datasets have entry rows (see `lookupSidesOf`).
    sideChecks = useQueries({
      queries: lookupSchemaIds.map((lookupSchemaId) =>
        convexQuery(api.derivedDatasets.get, { id: lookupSchemaId }),
      ),
    }),
    sides = lookupSidesOf(sideChecks),
    lookup = useEntryRowsBySchemas(
      lookupSchemaIds,
      schemaId !== undefined && specRead.resolved && sides.resolved && sides.allComponent,
    ),
    reportsBySchema = lookup.reportsBySchema,
    lookupRowsByDataset = lookupRowsByDatasetOf(lookupSchemaIds, reportsBySchema),
    joinedPending = joinedPendingOf(
      schemaId,
      specRead.resolved,
      sides,
      allLookupsComplete(lookupSchemaIds, reportsBySchema),
    );

  return {
    entry: enrichedEntryOf(
      entry,
      schemaId,
      joinedPending,
      specRead.specs,
      lookupRowsByDataset,
    ),
    joinedPending,
    loaders: lookup.loaders,
  };
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

/**
 * One schema's live entry-loading state, as `SchemaEntriesLoader` reports
 * it — the entry-row counterpart of `SchemaGeometriesReport`: `rows` are
 * the pages fetched so far (growing as the pass streams, final once
 * `complete`), and `complete` is true only after a FULL pagination pass.
 */
export interface SchemaEntriesReport {
  complete: boolean;
  rows: DatasetEntryRow[];
}

/**
 * Loads one schema's ENTRY rows (every page — see `useAllPaginated` riding
 * `entries.listPage`, the seam's reactive bulk path) and reports progress up
 * via `onLoaded` as it arrives. Renders nothing.
 *
 * The popup executor's join-side reader (issue #97): a derived spec's lookup
 * datasets stream through here only while their consumer holds the
 * subscription. `enabled: false` reports `undefined` AND un-latches
 * `complete`, so a reopened popup waits for a fresh full pass instead of
 * pairing a stale `complete` with an empty result set.
 *
 * Rows pass through `applyEntryRowSpecs` once per page arrival (the same
 * memo shape as `SchemaGeometriesLoader` — the fan-out's bail-out dedupes on
 * row reference, which keeps a future non-identity bulk step from becoming a
 * setState loop).
 */
export function SchemaEntriesLoader({
  schemaId,
  enabled,
  onLoaded,
}: {
  schemaId: string;
  enabled: boolean;
  onLoaded: (schemaId: string, report: SchemaEntriesReport | undefined) => void;
}) {
  const { results, status } = useAllPaginated(
      api.entries.listPage,
      enabled ? { schemaId } : "skip",
    ),
    completedRef = useRef(false),
    specRows = useMemo(() => applyEntryRowSpecs(results), [results]);
  useEffect(() => {
    if (!enabled) {
      completedRef.current = false;
      onLoaded(schemaId, undefined);
      return;
    }
    if (status === "Exhausted") {
      completedRef.current = true;
    }
    onLoaded(schemaId, { complete: completedRef.current, rows: specRows });
  }, [schemaId, status, specRows, onLoaded, enabled]);
  return null;
}

/**
 * Fan-out loader for several schemas' ENTRY rows: mounts one
 * `SchemaEntriesLoader` per schema and merges the results — the
 * `useGeometriesBySchemas` pattern (one stable `useAllPaginated` hook call
 * per schema component, since N reactive paginated queries cannot loop as
 * hooks). `reportsBySchema` is the live state map — a schema absent from it
 * (or `undefined`) has not completed a pass yet. The popup executor
 * (issue #97) is the consumer; rendering is the caller's job via `loaders`.
 */
export function useEntryRowsBySchemas(
  schemaIds: string[],
  enabled: boolean,
): {
  loaders: React.ReactNode[];
  reportsBySchema: globalThis.Map<string, SchemaEntriesReport | undefined>;
} {
  const [reportsBySchema, setReportsBySchema] = useState<
      globalThis.Map<string, SchemaEntriesReport | undefined>
    >(() => new globalThis.Map()),
    // Reference-stable across renders (the `useGeometriesBySchemas` doc
    // explains why this matters): the loader's own `useEffect` depends on
    // `onLoaded`, so a fresh identity per render would re-fire it every
    // time regardless of whether the rows changed.
    handleEntriesLoaded = useCallback(
      (schemaId: string, report: SchemaEntriesReport | undefined) => {
        setReportsBySchema((prev) => {
          const existing = prev.get(schemaId);
          // Bail out of the update entirely when nothing changed —
          // `new Map(prev)` always returns a new reference, so skipping it
          // here is what actually breaks the update loop.
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

  return {
    loaders: schemaIds.map((schemaId) => (
      <SchemaEntriesLoader
        key={schemaId}
        schemaId={schemaId}
        enabled={enabled}
        onLoaded={handleEntriesLoaded}
      />
    )),
    reportsBySchema,
  };
}

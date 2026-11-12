import {
  FILTER_OPERATORS,
  FILTER_VARIANTS,
  type ExtendedColumnFilter,
  type FilterOperator,
  type FilterVariant,
} from "@caden/ui/niko-table/types";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SortingState, Updater } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { applyEntryRowSpecs } from "#/lib/dataset-rows-pg";
import {
  SEARCH_ENTRIES_DEFAULT_LIMIT,
  searchEntriesQueryOptions,
  type EntryRow,
  type SearchEntriesArgs,
  type SearchEntriesPage,
  type SearchFilter,
  type SearchSort,
} from "#/lib/store/entries";
import { liveViewRowsQueryOptions } from "#/lib/store/views";
import { liveRowsToEntries, searchLiveEntries } from "#/lib/views/live-rows";

/**
 * The Postgres entries table's state layer (design doc §8.4): the
 * niko-table UI stays, but sort/filter/search stop being client-side row
 * models and become URL search params that drive the `search_entries` RPC
 * (§5.1) through keyset-paginated pages.
 *
 * Everything here is one source of truth deep: the URL. The table's
 * controlled TanStack state and the filter menu's controlled filters are both
 * projections of `PgTableState`; the handlers write it back through the
 * route's merge-form navigation.
 */

/**
 * The filter-menu row shape, generic over a record — the menu's `id` is a
 * COLUMN id (a declared property name), not a key of the entry row type, so
 * the record generic is the honest parameterization (the menu itself is
 * instantiated with this same generic in the table component).
 */
export type PgColumnFilter = ExtendedColumnFilter<Record<string, unknown>>;

/** The table view's server-driven state, URL-encoded via the three params below. */
export interface PgTableState {
  /** The search box value — rides the `q` param (the RPC's websearch query). */
  query: string;
  /** TanStack SortingState — rides the `sort` param as JSON. At most one entry is served (§5.1 sorts by one key). */
  sorting: SortingState;
  /** The filter menu's rows — ride the `filters` param as JSON. */
  filters: PgColumnFilter[];
}

export interface PgTableParams {
  q?: string;
  sort?: string;
  filters?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check for one JSON-decoded filter row — a hand-edited URL degrades to fewer filters, never a crash. */
function isColumnFilterLike(value: unknown): value is PgColumnFilter {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    (typeof value.value === "string" || Array.isArray(value.value)) &&
    typeof value.operator === "string" &&
    typeof value.variant === "string" &&
    typeof value.filterId === "string"
  );
}

/** Structural check for one JSON-decoded sorting row. */
function isSortingEntryLike(value: unknown): value is SortingState[number] {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" && value.id !== "" && (value.desc === true || value.desc === false)
  );
}

function parseJsonParam(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The table state a route's search params describe — malformed params degrade to absent, never throw. */
export function pgTableStateFromParams(params: PgTableParams): PgTableState {
  const query = params.q ?? "",
    rawSorting = parseJsonParam(params.sort),
    rawFilters = parseJsonParam(params.filters);
  return {
    filters: Array.isArray(rawFilters) ? rawFilters.filter(isColumnFilterLike) : [],
    query,
    sorting: Array.isArray(rawSorting) ? rawSorting.filter(isSortingEntryLike) : [],
  };
}

/**
 * Drops the state rows whose column key the dataset does NOT declare — the
 * second URL-degrade layer, for a param that is STRUCTURALLY valid but names
 * an undeclared property. Without it, a hand-edited `sort`/`filters` value
 * rides to `search_entries`, whose key validation raises `invalid key` — the
 * rejected query threw into the page's error boundary, whose fallback is the
 * "Dataset Not Found" card, for an EXISTING dataset (the tranche-1 review
 * defect). A dropped row reads as the DEFAULT state (no sort / fewer
 * filters), the same degrade-to-fewer rule the malformed-param parse above
 * follows. The empty set (dataset row not loaded yet) degrades to the full
 * default state for one tick until the declared keys arrive.
 *
 * `q` passes through untouched: it is websearch TEXT, parsed safely inside
 * the RPC, and nothing about it can make the RPC reject.
 */
export function sanitizePgTableState(
  state: PgTableState,
  declaredKeys: ReadonlySet<string>,
): PgTableState {
  return {
    filters: state.filters.filter((filter) => declaredKeys.has(filter.id)),
    query: state.query,
    sorting: state.sorting.filter((entry) => declaredKeys.has(entry.id)),
  };
}

/** The search-param patch for a table state — absent values are dropped from the URL entirely (the default state never appears). */
export function pgTableParamsFromState(state: PgTableState): PgTableParams {
  const params: PgTableParams = {};
  if (state.query !== "") {
    params.q = state.query;
  }
  if (state.sorting.length > 0) {
    params.sort = JSON.stringify(state.sorting);
  }
  if (state.filters.length > 0) {
    params.filters = JSON.stringify(state.filters);
  }
  return params;
}

/** The first sorting entry as the RPC's `{key, dir}` — §5.1 sorts by ONE key; extra entries are ignored. */
export function sortingToSearchSort(sorting: SortingState): SearchSort | undefined {
  const first = sorting[0];
  return first === undefined ? undefined : { dir: first.desc ? "desc" : "asc", key: first.id };
}

/**
 * The filter type of a server-mode column — the declared JSON Schema property
 * type (`declaredPropertyTypes` derives it). Drives the menu's variant and
 * the §5.1 filter-value coercion: the RPC's `eq` is jsonb CONTAINMENT, so a
 * numeric column filtered by the text "5" matches nothing (5 ≠ "5").
 */
export type PgPropertyType = "boolean" | "number" | "string";

/**
 * The operators each server-mode variant's menu offers: exactly the §5.1 op
 * set the RPC serves, narrowed per variant. `contains` is the text variant's
 * `ilike`; ranges are number-only (the RPC casts both sides to numeric, so
 * they mean nothing on text/boolean columns); `in` needs no menu row —
 * repeated `is` rows on a column collapse into one, the niko-table equality
 * merge. The menu cannot offer an operator this table doesn't map
 * (no-optional-chaining of controls), and `filtersToSearchFilters` still
 * drops anything unserved that arrives out of band (a hand-edited URL), the
 * same degrade-to-fewer-filters rule its malformed rows follow.
 */
export const SERVED_FILTER_OPERATORS: ReadonlyMap<FilterVariant, readonly FilterOperator[]> =
  new Map<FilterVariant, readonly FilterOperator[]>([
    [FILTER_VARIANTS.TEXT, [FILTER_OPERATORS.ILIKE, FILTER_OPERATORS.EQ, FILTER_OPERATORS.NEQ]],
    [
      FILTER_VARIANTS.NUMBER,
      [
        FILTER_OPERATORS.EQ,
        FILTER_OPERATORS.NEQ,
        FILTER_OPERATORS.LT,
        FILTER_OPERATORS.LTE,
        FILTER_OPERATORS.GT,
        FILTER_OPERATORS.GTE,
      ],
    ],
    [FILTER_VARIANTS.BOOLEAN, [FILTER_OPERATORS.EQ, FILTER_OPERATORS.NEQ]],
  ]);

/** The filter variant a declared property type's column uses in server mode. */
export function servedVariantOf(type: PgPropertyType): FilterVariant {
  if (type === "number") {
    return FILTER_VARIANTS.NUMBER;
  }
  return type === "boolean" ? FILTER_VARIANTS.BOOLEAN : FILTER_VARIANTS.TEXT;
}

/**
 * One filter value coerced to the declared column type, or undefined when it
 * can't be — a non-numeric value on a number column (or anything on a boolean
 * one) would produce a §5.1 predicate that matches nothing, so the row drops
 * instead of silently filtering everything out (the Convex client's NaN-guard
 * semantics). Without schema info the value passes through as the string the
 * menu produced.
 */
function coerceToColumnValue(value: string, type: PgPropertyType | undefined): unknown {
  if (type === undefined) {
    return value;
  }
  if (type === "number") {
    const parsed = Number(value);
    return value !== "" && Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === "boolean") {
    return value === "true" ? true : value === "false" ? false : undefined;
  }
  return value;
}

/** One eq/neq payload: each member coerced to the column's type, or undefined when any member can't be. */
function coerceEqualityValue(value: string | string[], type: PgPropertyType | undefined): unknown {
  if (Array.isArray(value)) {
    const coerced: unknown[] = [];
    for (const member of value) {
      const one = coerceToColumnValue(member, type);
      if (one === undefined) {
        return undefined;
      }
      coerced.push(one);
    }
    return coerced;
  }
  return coerceToColumnValue(value, type);
}

/**
 * The filter-menu rows as `search_entries` filters (§5.1's op set). Values
 * coerce to the column's declared type (`columnTypes`, derived from the
 * dataset's JSON Schema) — the typed `eq` containment needs the CELL's type,
 * not the input's text. Menu operators without an RPC counterpart — "does
 * not contain" (`not.ilike`), `not.in`, `between`, empty/not-empty, relative
 * dates — are dropped: the server-mode menu only OFFERS served operators
 * (`SERVED_FILTER_OPERATORS`, via the columns' `meta.filterOperators`), so a
 * dropped row here means it arrived out of band (a hand-edited URL), the same
 * degrade-to-fewer-filters rule the malformed-param parse follows.
 */
export function filtersToSearchFilters(
  filters: ReadonlyArray<PgColumnFilter>,
  columnTypes?: ReadonlyMap<string, PgPropertyType>,
): SearchFilter[] {
  const out: SearchFilter[] = [];
  for (const filter of filters) {
    const type = columnTypes === undefined ? undefined : columnTypes.get(filter.id);
    if (Array.isArray(filter.value)) {
      if (filter.operator === "in" && filter.value.length > 0) {
        // `in` is exact TEXT membership over data->>key: numbers/booleans
        // text-ify to the same members their strings would, so the array
        // passes through as the menu produced it.
        out.push({ key: filter.id, op: "in", value: filter.value });
      }
      continue;
    }
    if (filter.value === "") {
      continue;
    }
    if (filter.operator === "ilike") {
      out.push({ key: filter.id, op: "contains", value: filter.value });
    } else if (filter.operator === "eq" || filter.operator === "neq") {
      const coerced = coerceEqualityValue(filter.value, type);
      if (coerced !== undefined) {
        out.push({ key: filter.id, op: filter.operator, value: coerced });
      }
    } else if (
      filter.operator === "gt" ||
      filter.operator === "gte" ||
      filter.operator === "lt" ||
      filter.operator === "lte"
    ) {
      // Ranges ride the RPC's numeric casts, which accept the text form too —
      // coercion only matters when the column is numeric and the text isn't.
      const coerced = type === "number" ? coerceEqualityValue(filter.value, type) : filter.value;
      if (coerced !== undefined) {
        out.push({ key: filter.id, op: filter.operator, value: coerced });
      }
    }
  }
  return out;
}

/** The RPC args one table state produces for a page at `cursor`. */
export function searchArgsOf(
  datasetId: string,
  state: PgTableState,
  cursor: string | null,
  columnTypes?: ReadonlyMap<string, PgPropertyType>,
): SearchEntriesArgs {
  return {
    cursor,
    datasetId,
    filters: filtersToSearchFilters(state.filters, columnTypes),
    limit: SEARCH_ENTRIES_DEFAULT_LIMIT,
    query: state.query === "" ? undefined : state.query,
    sort: sortingToSearchSort(state.sorting),
  };
}

/** Stable string for "did the server-driven state change" — the page chain resets when it did. */
export function stateKeyOf(state: PgTableState): string {
  return JSON.stringify([
    state.query,
    state.sorting,
    state.filters.map((filter) => [filter.id, filter.operator, filter.value, filter.filterId]),
  ]);
}

/** One query slot's rows, or none while pending. */
function pageRowsOf(result: UseQueryResult<SearchEntriesPage> | undefined): EntryRow[] {
  if (result === undefined || result.data === undefined) {
    return [];
  }
  return result.data.rows;
}

/**
 * One query slot's `nextCursor` — null while pending or exhausted; the two
 * are distinguished by `isComplete`'s success check, never by this alone.
 */
function pageCursorOf(result: UseQueryResult<SearchEntriesPage> | undefined): string | null {
  if (result === undefined || result.isPending || result.data === undefined) {
    return null;
  }
  return result.data.nextCursor;
}

/**
 * The server-driven entries pages: one `search_entries` query per accumulated
 * keyset cursor, chained on `nextCursor` (null = exhausted — the §8.3
 * completeness semantics). `loadMore` appends the next cursor once the last
 * page has resolved; a change to the server-driven state restarts the chain
 * (same shape as `useDatasetEntryPages`' dataset-keyed reset). `columnTypes`
 * (the declared property types) drives the filter-value coercion — see
 * `filtersToSearchFilters`.
 */
/** The {@link useSearchEntriesPages} result: the visible rows plus the streaming/completeness flags the ui-polish rules gate on. */
export interface SearchPagesResult {
  rows: EntryRow[];
  isLoading: boolean;
  isLoadingMore: boolean;
  canLoadMore: boolean;
  isComplete: boolean;
  /** A live view's cap facts (#331); undefined elsewhere. */
  liveTruncation?: { rowCount: number; rowCap: number; truncated: boolean };
  loadMore: () => void;
}

export function useSearchEntriesPages(
  datasetId: string,
  state: PgTableState,
  columnTypes?: ReadonlyMap<string, PgPropertyType>,
  /** A live view: no saved rows to page, so one capped server read is searched/sorted client-side. */
  live = false,
) {
  // The live branch (#331): ONE capped server read on a stable key — the
  // search/sort/filter arguments apply client-side over the cached rows, so
  // typing or sorting never re-fetches the read.
  const liveRead = useQuery({
    ...liveViewRowsQueryOptions(datasetId),
    enabled: live,
  });
  const livePage = useMemo(() => {
    if (!live || liveRead.data === undefined) {
      return undefined;
    }
    const base = liveRowsToEntries(datasetId, liveRead.data.rows);
    return searchLiveEntries(base, searchArgsOf(datasetId, state, null, columnTypes));
    // The args ride `state` as one reference; oxlint forbids the spread-list
    // deps this would otherwise need.
    // oxlint-disable-next-line react/exhaustive-deps -- `state` is the single source of the search args.
  }, [live, liveRead.data, datasetId, state]);

  const stateKey = stateKeyOf(state),
    // Keyed on the state so navigating between datasets (or a changed
    // filter/sort/search) restarts the chain instead of replaying old cursors.
    [chain, setChain] = useState<{ cursors: Array<string | null>; key: string }>({
      cursors: [null],
      key: stateKey,
    }),
    cursors = chain.key === stateKey ? chain.cursors : [null],
    // Rebuilt per render (cheap — a map over the cursor list); TanStack Query
    // hashes the keys structurally, so a fresh args object per render still
    // matches the cached page.
    results = useQueries({
      queries: cursors.map((cursor) => {
        const args = searchArgsOf(datasetId, state, cursor, columnTypes);
        return searchEntriesQueryOptions(args);
      }),
    }),
    firstResult = results[0],
    lastResult = results[cursors.length - 1],
    lastCursor = pageCursorOf(lastResult);

  const loadMore = () => {
    if (lastCursor === null) {
      return;
    }
    setChain((prev) => {
      const active = prev.key === stateKey ? prev.cursors : [null],
        last = active[active.length - 1];
      if (last === lastCursor) {
        return prev;
      }
      return { cursors: [...active, lastCursor], key: stateKey };
    });
  };

  if (live) {
    // The live result (#331): the whole capped read searched client-side —
    // one page, no cursor chain, and the truncation facts the UI surfaces.
    const truncated = liveRead.data !== undefined && liveRead.data.truncated;
    return {
      rows: applyEntryRowSpecs(livePage === undefined ? [] : livePage.rows),
      isLoading: liveRead.isPending,
      isLoadingMore: false,
      canLoadMore: false,
      isComplete: liveRead.isSuccess,
      loadMore: () => undefined,
      liveTruncation:
        liveRead.data === undefined
          ? undefined
          : {
              rowCount: liveRead.data.rows.length,
              rowCap: liveRead.data.rowCap,
              truncated,
            },
    };
  }
  return {
    rows: applyEntryRowSpecs(results.flatMap(pageRowsOf)),
    // The first page's pending state only — later pages stream in below the
    // fold and must never blank the table (the ui-polish rule).
    isLoading: firstResult === undefined ? true : firstResult.isPending,
    isLoadingMore: cursors.length > 1 && lastResult !== undefined && lastResult.isPending,
    canLoadMore: lastCursor !== null,
    // Completeness rides the RPC's null cursor on a RESOLVED last page —
    // never `isLoading`, which drops after the first page lands.
    isComplete: lastResult !== undefined && lastResult.isSuccess && lastCursor === null,
    liveTruncation: undefined,
    loadMore,
  };
}

/** Applies a TanStack `Updater` against `current` — the controlled-state handler contract. */
export function resolveUpdater<T>(updater: Updater<T>, current: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `T` here is only ever TanStack's array states (SortingState/ColumnFiltersState), never itself a function, so the Updater union's function arm is the callable one.
  return typeof updater === "function" ? (updater as (old: T) => T)(current) : updater;
}

import type { ExtendedColumnFilter } from "@caden/ui/niko-table/types";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { SortingState, Updater } from "@tanstack/react-table";
import { useState } from "react";

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
 * The filter-menu rows as `search_entries` filters (§5.1's op set). Menu
 * operators without an RPC counterpart — "does not contain" (`not.ilike`),
 * `not.in`, `between`, empty/not-empty, relative dates — are dropped: the
 * §5.1 contract fixes the op list, and an AND-only list is all it accepts
 * (see the stage-1 deviations note on the dataset page).
 */
export function filtersToSearchFilters(filters: ReadonlyArray<PgColumnFilter>): SearchFilter[] {
  const out: SearchFilter[] = [];
  for (const filter of filters) {
    if (Array.isArray(filter.value)) {
      if (filter.operator === "in" && filter.value.length > 0) {
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
      out.push({ key: filter.id, op: filter.operator, value: filter.value });
    } else if (
      filter.operator === "gt" ||
      filter.operator === "gte" ||
      filter.operator === "lt" ||
      filter.operator === "lte"
    ) {
      out.push({ key: filter.id, op: filter.operator, value: filter.value });
    }
  }
  return out;
}

/** The RPC args one table state produces for a page at `cursor`. */
export function searchArgsOf(
  datasetId: string,
  state: PgTableState,
  cursor: string | null,
): SearchEntriesArgs {
  return {
    cursor,
    datasetId,
    filters: filtersToSearchFilters(state.filters),
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
 * (same shape as `useDatasetEntryPages`' dataset-keyed reset).
 */
export function useSearchEntriesPages(datasetId: string, state: PgTableState) {
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
      queries: cursors.map((cursor) =>
        searchEntriesQueryOptions(searchArgsOf(datasetId, state, cursor)),
      ),
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
    loadMore,
  };
}

/** Applies a TanStack `Updater` against `current` — the controlled-state handler contract. */
export function resolveUpdater<T>(updater: Updater<T>, current: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `T` here is only ever TanStack's array states (SortingState/ColumnFiltersState), never itself a function, so the Updater union's function arm is the callable one.
  return typeof updater === "function" ? (updater as (old: T) => T)(current) : updater;
}

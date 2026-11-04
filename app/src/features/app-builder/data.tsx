import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { ENTRIES_PAGE_SIZE, entryDataRecord, type DatasetEntryRow } from "#/lib/dataset-rows-pg";
import { getQueryOptions, type DatasetRow } from "#/lib/store/datasets";
import { listPage } from "#/lib/store/entries";

import type { DataRecord } from "./lib/aggregate";
import { fieldsOfSchema, type DatasetField } from "./lib/fields";

/**
 * The app builder's data access — the ONE place the feature reads the rest
 * of the app's data APIs (the PG stores). Every read goes through the
 * normal, RLS-checked dataset reads as the CURRENT viewer, so an app never
 * shows anyone data they couldn't open on its dataset page: a viewer
 * without access to a source dataset gets an "unavailable" widget, never
 * the data.
 */

/** One dataset's full store row (`#/lib/store/datasets` — json schema included for the field pickers). */
export type DatasetDoc = DatasetRow;

export type DatasetState =
  | { status: "loading" }
  /** Deleted, or not visible to this viewer (an RLS-hidden row reads as missing). */
  | { status: "unavailable" }
  | { status: "ready"; doc: DatasetDoc; fields: DatasetField[] };

const LOADING: DatasetState = { status: "loading" },
  UNAVAILABLE: DatasetState = { status: "unavailable" };

const AppDatasetsContext = createContext<ReadonlyMap<string, DatasetState>>(new Map());

/**
 * Resolves an app's data sources once for every widget beneath it: one full
 * row read per dataset (≤ 20, `APP_LIMITS.datasets`). Errors are captured
 * as query state rather than thrown (TanStack Query), so one unavailable
 * dataset degrades its widgets instead of the page.
 */
export function AppDatasetsProvider({
  datasetIds,
  children,
}: {
  datasetIds: readonly string[];
  children: ReactNode;
}) {
  const results = useQueries({
    queries: datasetIds.map((datasetId) => ({
      ...getQueryOptions({ datasetId }),
      retry: false,
    })),
  });
  const states = new Map<string, DatasetState>(
    datasetIds.map((datasetId, index): [string, DatasetState] => {
      const result = results[index];
      if (result === undefined || result.isError) {
        return [datasetId, UNAVAILABLE];
      }
      if (result.isPending) {
        return [datasetId, LOADING];
      }
      if (result.data === null) {
        return [datasetId, UNAVAILABLE];
      }
      return [
        datasetId,
        {
          doc: result.data,
          fields: fieldsOfSchema(result.data.jsonSchema),
          status: "ready",
        },
      ];
    }),
  );
  return <AppDatasetsContext value={states}>{children}</AppDatasetsContext>;
}

export function useAppDatasets(): ReadonlyMap<string, DatasetState> {
  return useContext(AppDatasetsContext);
}

export function useAppDataset(datasetId: string): DatasetState {
  const state = useAppDatasets().get(datasetId);
  return state ?? UNAVAILABLE;
}

/** The dataset's title for labels, falling back gracefully while loading or when unavailable. */
export function datasetTitle(state: DatasetState): string {
  if (state.status === "ready") {
    return state.doc.title;
  }
  return state.status === "loading" ? "Loading…" : "Unavailable dataset";
}

const EMPTY: DataRecord[] = [];

/**
 * Every entry of one dataset as plain data records — the chart and stat
 * widgets aggregate over these. One cursor-chained `entries.listPage` read
 * paged to EXHAUSTION (the store's `nextCursor === null` — the §5 intro
 * completeness rule): `complete` is the real "every row loaded" signal,
 * never `isLoading`, which drops after the first page (the ui-polish rule).
 * The auto-chain rides the same effect the PG geometry loader uses
 * (`features/maps/components/pg-geometries-loader.tsx`).
 */
export function useDatasetRecords(datasetId: string): {
  records: DataRecord[];
  complete: boolean;
} {
  const page = useInfiniteQuery({
    queryKey: ["pg:entries", "appBuilderRecords", datasetId],
    queryFn: async ({ pageParam }) =>
      await listPage({ cursor: pageParam, datasetId, numItems: ENTRIES_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  useEffect(() => {
    if (page.hasNextPage && !page.isFetchingNextPage) {
      void page.fetchNextPage();
    }
  }, [page]);
  const records = useMemo(
    () =>
      page.data === undefined
        ? EMPTY
        : page.data.pages.flatMap((one) => one.rows.map(entryDataRecord)),
    [page.data],
  );
  return {
    // Exhausted + resolved — not `isLoading`, which is false from the first
    // page onward while later pages are still streaming.
    complete: page.data !== undefined && !page.hasNextPage,
    records,
  };
}

/**
 * One dataset's entry rows as a growing set of cursor-chained pages — the
 * table widget's streaming read (the Convex seam's `useDatasetEntryPages`
 * shape). Unlike `useDatasetRecords` this does NOT auto-page: `loadMore`
 * (wired to the table's scroll-near-end and its button) appends the next
 * page while `canLoadMore`.
 */
export function useAppEntryPages(datasetId: string): {
  rows: DatasetEntryRow[];
  /** True only while the FIRST page is pending — later pages stream below the fold. */
  isLoading: boolean;
  isLoadingMore: boolean;
  canLoadMore: boolean;
  loadMore: () => void;
} {
  const page = useInfiniteQuery({
    queryKey: ["pg:entries", "appBuilderEntryPages", datasetId],
    queryFn: async ({ pageParam }) =>
      await listPage({ cursor: pageParam, datasetId, numItems: ENTRIES_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const rows = useMemo(
    () => (page.data === undefined ? [] : page.data.pages.flatMap((one) => one.rows)),
    [page.data],
  );
  return {
    canLoadMore: page.hasNextPage,
    isLoading: page.isPending,
    isLoadingMore: page.isFetchingNextPage,
    loadMore: () => {
      if (page.hasNextPage && !page.isFetchingNextPage) {
        void page.fetchNextPage();
      }
    },
    rows,
  };
}

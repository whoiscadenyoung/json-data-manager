import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { ENTRIES_PAGE_SIZE, entryDataRecord, type DatasetEntryRow } from "#/lib/dataset-rows-pg";
import type { AppVersionDefinition } from "#/lib/store/app-versions";
import { getQueryOptions, type DatasetGeometryType, type DatasetRow } from "#/lib/store/datasets";
import { listPage } from "#/lib/store/entries";
import { versionEntriesQueryOptions, type VersionEntryRow } from "#/lib/store/versions";

import type { DataRecord } from "./lib/aggregate";
import { fieldsOfSchema, type DatasetField } from "./lib/fields";

/**
 * The app builder's data access — the ONE place the feature reads the rest
 * of the app's data APIs (the PG stores). Every read goes through the
 * normal, RLS-checked dataset reads as the CURRENT viewer, so an app never
 * shows anyone data they couldn't open on its dataset page: a viewer
 * without access to a source dataset gets an "unavailable" widget, never
 * the data.
 *
 * Published mode (issue #259, D7): the viewer renders the HEAD app_version,
 * and `AppFrozenProvider` supplies the frozen snapshot. Widgets read the
 * same hooks either way — under the provider, `useAppDatasets` builds its
 * states from the snapshot's datasetPins (title/schema/geometry facts
 * frozen at publish; a null pin renders "unavailable") and map widgets
 * resolve their `mapSnapshots` — never the live rows. That is what makes
 * "editing the live map afterwards does not change the published app until
 * republish" true at render time.
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

/** The frozen publish snapshot, present only beneath the published view (AppViewPage's frozen branch). */
const AppFrozenContext = createContext<AppVersionDefinition | null>(null);

export function AppFrozenProvider({
  definition,
  children,
}: {
  definition: AppVersionDefinition;
  children: ReactNode;
}) {
  return <AppFrozenContext value={definition}>{children}</AppFrozenContext>;
}

/** The published snapshot beneath a frozen render, or null in every live surface (builder, preview, drafts). */
export function useAppFrozen(): AppVersionDefinition | null {
  return useContext(AppFrozenContext);
}

/** A pin's dataset as the doc shape the widgets read — inert defaults for the fields a frozen snapshot never carries. */
function frozenDocOf(pin: AppVersionDefinition["datasetPins"][number]): DatasetRow {
  return {
    bbox: null,
    createdAt: "",
    createdBy: "",
    description: null,
    editPolicy: "open",
    entryCount: 0,
    featureCount: 0,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pin carries the wire's string; the PG union allows GeometryCollection and the app never writes one (the pgGeometryToLayerRow posture).
    geometryType: pin.geometryType as DatasetGeometryType | null,
    groupId: null,
    id: pin.datasetId,
    isGeospatial: pin.isGeospatial,
    jsonSchema: pin.jsonSchema,
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveBytes: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileArchivePath: null,
    mapTileCacheVersion: 0,
    maxGeometryRowBytes: null,
    properties: [],
    publishedVisibility: "everyone",
    simplifyGeometry: false,
    source: null,
    sourceFilePath: null,
    sourceFileName: null,
    sourceFileSize: null,
    title: pin.title ?? "Unavailable dataset",
    updatedAt: "",
  };
}

/**
 * Resolves an app's data sources once for every widget beneath it: one full
 * row read per dataset (≤ 20, `APP_LIMITS.datasets`), or — beneath the
 * published view's frozen provider — the pins, with no live reads at all.
 * Errors are captured as query state rather than thrown (TanStack Query),
 * so one unavailable dataset degrades its widgets instead of the page.
 */
export function AppDatasetsProvider({
  datasetIds,
  children,
}: {
  datasetIds: readonly string[];
  children: ReactNode;
}) {
  const frozen = useAppFrozen();
  const results = useQueries({
    queries:
      frozen === null
        ? datasetIds.map((datasetId) => ({
            ...getQueryOptions({ datasetId }),
            retry: false,
          }))
        : [],
  });
  const states = new Map<string, DatasetState>(
    frozen !== null
      ? frozen.datasetPins
          .filter((pin) => datasetIds.includes(pin.datasetId))
          .map((pin): [string, DatasetState] => [
            pin.datasetId,
            pin.versionId === null
              ? UNAVAILABLE
              : { doc: frozenDocOf(pin), fields: fieldsOfSchema(pin.jsonSchema), status: "ready" },
          ])
      : datasetIds.map((datasetId, index): [string, DatasetState] => {
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

/** The pin's version id for one dataset (null when unfrozen, unpinned, or absent — the honest "no frozen rows" answer). */
function pinnedVersionIdOf(frozen: AppVersionDefinition | null, datasetId: string): string | null {
  if (frozen === null) {
    return null;
  }
  const pin = frozen.datasetPins.find((candidate) => candidate.datasetId === datasetId);
  return pin === undefined ? null : pin.versionId;
}

const EMPTY: DataRecord[] = [];

/**
 * One page of one dataset's rows, live or frozen: live pages through
 * `entries.listPage`, frozen pages through the snapshot pin's
 * `version_entries` chain (immutable rows — the published view's read).
 */
async function datasetPage(
  pageParam: string | number | null,
  datasetId: string,
  versionId: string | null,
) {
  if (versionId !== null) {
    const options = versionEntriesQueryOptions({ cursor: pageParam as number | null, versionId }),
      fn = options.queryFn;
    if (fn === undefined) {
      throw new Error("The version-entries read carries no queryFn.");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context (the pg-app-publish note).
    return fn({} as never) as Promise<{ nextCursor: number | null; rows: VersionEntryRow[] }>;
  }
  return listPage({ cursor: pageParam as string | null, datasetId, numItems: ENTRIES_PAGE_SIZE });
}

/**
 * Every entry of one dataset as plain data records — the chart and stat
 * widgets aggregate over these. One cursor-chained read paged to EXHAUSTION
 * (the store's `nextCursor === null` — the §5 intro completeness rule):
 * `complete` is the real "every row loaded" signal, never `isLoading`,
 * which drops after the first page (the ui-polish rule). Beneath the
 * published view's frozen provider the read pages the pinned version's
 * frozen rows instead of the live dataset. The auto-chain rides the same
 * effect the PG geometry loader uses
 * (`features/maps/components/pg-geometries-loader.tsx`).
 */
export function useDatasetRecords(datasetId: string): {
  records: DataRecord[];
  complete: boolean;
} {
  const frozen = useAppFrozen(),
    versionId = pinnedVersionIdOf(frozen, datasetId);
  const page = useInfiniteQuery({
    queryKey: ["pg:entries", "appBuilderRecords", { datasetId, versionId }],
    queryFn: async ({ pageParam }) => await datasetPage(pageParam, datasetId, versionId),
    initialPageParam: null as string | number | null,
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
        : page.data.pages.flatMap((one) =>
            one.rows.map((row) => entryDataRecord(row as DatasetEntryRow)),
          ),
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
 * shape; frozen under the published view's provider). Unlike
 * `useDatasetRecords` this does NOT auto-page: `loadMore` (wired to the
 * table's scroll-near-end and its button) appends the next page while
 * `canLoadMore`.
 */
export function useAppEntryPages(datasetId: string): {
  rows: DatasetEntryRow[];
  /** True only while the FIRST page is pending — later pages stream below the fold. */
  isLoading: boolean;
  isLoadingMore: boolean;
  canLoadMore: boolean;
  loadMore: () => void;
} {
  const frozen = useAppFrozen(),
    versionId = pinnedVersionIdOf(frozen, datasetId);
  const page = useInfiniteQuery({
    queryKey: ["pg:entries", "appBuilderEntryPages", { datasetId, versionId }],
    queryFn: async ({ pageParam }) => await datasetPage(pageParam, datasetId, versionId),
    initialPageParam: null as string | number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const rows = useMemo(
    () =>
      page.data === undefined
        ? []
        : page.data.pages.flatMap((one) => one.rows as DatasetEntryRow[]),
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

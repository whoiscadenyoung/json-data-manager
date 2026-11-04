import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";
import { applyGeometryRowSpecs, resolveGeometryRows } from "#/lib/dataset-rows-pg";
import { rowsForTiles, type GeometryRow } from "#/lib/store/geometries";

import { pgGeometryToLayerRow } from "./pg-layer-rows";

/**
 * The Postgres half of the workspace's geometry fan-out — the
 * `useGeometriesBySchemas` pattern (the Convex seam's reactive loader)
 * running on the PG store: one component per dataset, each PAGING the
 * dataset's geometry rows through `dataset_rows_for_tiles` (design §5.5 —
 * the one read that pulls coordinate payloads, "reserved for map
 * rendering"), RESOLVING them (inline jsonb synchronously; storage-backed
 * rows through short-lived signed URLs — `resolveGeometryRows`, the seam's
 * resolution half), adapting each row into the pipeline's
 * `DatasetGeometryRow` shape (`pgGeometryToLayerRow`), and reporting
 * progress up exactly like the Convex loader: partial rows stream as pages
 * land, `complete` only after a full pass (cursor-chained to exhaustion —
 * `nextCursor === null`).
 *
 * Spec application rides the seam's `applyGeometryRowSpecs` (identity until
 * stage 5's geometrySource specs exist) — the same step the Convex loader
 * applies, so a future spec transform lands in both backends at once.
 *
 * Resolution is CACHED across pages in a ref (only rows that haven't
 * resolved yet hit Storage again), so a streaming pass signs each oversized
 * payload once.
 */

/** Minimum gap between partial-pass reports from one loader (the #186 rule — one source rebuild per report). */
const GEOMETRY_REPORT_INTERVAL_MS = 250;

/** One dataset's live geometry-loading state, as the Convex loader reports it. */
export interface PgGeometriesReport {
  complete: boolean;
  rows: DatasetGeometryRow[];
}

/** The loader's page width — the tile feed's default (§5.5), not a reactive-layer width. */
export const PG_LOADER_PAGE_ROWS = 5000;

/**
 * Loads one PG dataset's geometry rows (every page of the tile feed) and
 * reports progress up via `onLoaded` as it arrives. Renders nothing.
 *
 * Cursor chaining + completeness latching mirror `SchemaGeometriesLoader`
 * (dataset-rows-react): `complete` flips on the first finished pass and
 * stays up across background re-reads, so a mounted map never re-skeletons.
 */
export function PgGeometriesLoader({
  datasetId,
  onLoaded,
}: {
  datasetId: string;
  onLoaded: (datasetId: string, report: PgGeometriesReport | undefined) => void;
}) {
  const page = useInfiniteQuery({
      queryKey: ["pg:geometries", "rowsForTiles", { datasetId, limit: PG_LOADER_PAGE_ROWS }],
      queryFn: async ({ pageParam }) =>
        await rowsForTiles({ cursor: pageParam, datasetId, limit: PG_LOADER_PAGE_ROWS }),
      initialPageParam: null as string | null,
      // null = exhausted (the `isDone` analogue, design §5 intro).
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }),
    completedRef = useRef(false),
    cancelledRef = useRef(false),
    lastReportRef = useRef(0),
    rowsRef = useRef<GeometryRow[]>([]),
    resolvedRef = useRef<globalThis.Map<string, unknown>>(new globalThis.Map()),
    timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Auto-page: chain the next cursor while the feed has one (design §5.5's
  // keyset). The paging machinery — and its load-more callback — is
  // TanStack's `useInfiniteQuery`, the exact shape the Convex path hides
  // inside `useAllPaginated`'s load-more effect (all-paginated.ts:111-115).
  useEffect(() => {
    if (page.hasNextPage && !page.isFetchingNextPage) {
      void page.fetchNextPage();
    }
  }, [page]);

  // Accumulate rows + resolutions, then report (trailing-edge debounced for
  // partial passes; immediate on completion and re-reads). `page.data` is
  // the query cache's stable reference, so this re-runs per PAGE arrival,
  // not per render.
  useEffect(() => {
    const data = page.data;
    if (data === undefined) {
      return undefined;
    }
    const pages = data.pages;
    cancelledRef.current = false;
    if (!page.hasNextPage) {
      completedRef.current = true;
    }
    const fetched: GeometryRow[] = [],
      existingIds = new Set(rowsRef.current.map((row) => row.entryId));
    for (const onePage of pages) {
      for (const row of onePage.rows) {
        if (!existingIds.has(row.entryId)) {
          existingIds.add(row.entryId);
          fetched.push(row);
        }
      }
    }
    rowsRef.current = dedupeById([...rowsRef.current, ...fetched]);
    const work = async () => {
      await resolveFreshRows(fetched, resolvedRef);
      if (cancelledRef.current) {
        return;
      }
      const resolvedMap = resolvedRef.current,
        rows = applyGeometryRowSpecs(rowsRef.current).map((row) =>
          pgGeometryToLayerRow(
            row,
            resolvedMap === null ? undefined : resolvedMap.get(row.entryId),
          ),
        );
      const flush = () => {
        lastReportRef.current = Date.now();
        onLoaded(datasetId, { complete: completedRef.current, rows });
      };
      const wait = lastReportRef.current + GEOMETRY_REPORT_INTERVAL_MS - Date.now();
      if (completedRef.current || wait <= 0) {
        flush();
        return;
      }
      const timer = setTimeout(() => {
        if (!cancelledRef.current) {
          flush();
        }
      }, wait);
      timersRef.current.push(timer);
    };
    void work();
    return () => {
      cancelledRef.current = true;
      for (const timer of timersRef.current) {
        clearTimeout(timer);
      }
      timersRef.current = [];
    };
  }, [datasetId, onLoaded, page.data, page.hasNextPage]);

  return null;
}

/** Rows keyed by entry id, first occurrence wins (a re-read page must not duplicate a row). */
function dedupeById(rows: GeometryRow[]): GeometryRow[] {
  const seen = new Set<string>(),
    kept: GeometryRow[] = [];
  for (const row of rows) {
    if (!seen.has(row.entryId)) {
      seen.add(row.entryId);
      kept.push(row);
    }
  }
  return kept;
}

/** Resolves the rows that have no cached resolution yet into the ref's map (inline rows resolve synchronously; storage rows fetch). */
async function resolveFreshRows(
  freshRows: GeometryRow[],
  resolvedRef: React.RefObject<globalThis.Map<string, unknown>>,
): Promise<void> {
  const resolvedMap = resolvedRef.current;
  if (resolvedMap === null) {
    return;
  }
  const pending = freshRows.filter((row) => !resolvedMap.has(row.entryId));
  if (pending.length === 0) {
    return;
  }
  const resolved = await resolveGeometryRows(pending);
  for (const [entryId, geometry] of resolved) {
    resolvedMap.set(entryId, geometry);
  }
}

/**
 * Fan-out loader for several PG datasets' geometries — the
 * `useGeometriesBySchemas` shape (one stable component per dataset, since N
 * reactive paginated queries cannot loop as hooks). Returns `loaders`
 * (render them alongside the UI — they are what fetches), `geometries`
 * (`undefined` until EVERY dataset finished a full pass) and
 * `servedGeometries` (rows streaming as pages arrive — the mounted map's
 * incremental fill), with the same reference-stable bail-out dedupe.
 */
export function useGeometriesByPgDatasets(datasetIds: string[]): {
  geometries: DatasetGeometryRow[] | undefined;
  loaders: ReactNode[];
  servedGeometries: DatasetGeometryRow[] | undefined;
} {
  const [reportsByDataset, setReportsByDataset] = useState<
      globalThis.Map<string, PgGeometriesReport | undefined>
    >(() => new globalThis.Map()),
    // Reference-stable across renders (the useGeometriesBySchemas doc
    // explains why a fresh identity here would loop the loaders' effects):
    // the body only closes over the stable useState setter.
    // oxlint-disable-next-line react/preserve-manual-memoization -- the dataset-rows-react `useGeometriesBySchemas` shape verbatim (stable setter dep + bail-out dedupe); the compiler cannot prove it preserved across the seam's report type, and the loaders' effects loop without the stable identity.
    handleLoaded = useCallback(
      (datasetId: string, report: PgGeometriesReport | undefined) => {
        setReportsByDataset((prev) => {
          const existing = prev.get(datasetId);
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
          return new globalThis.Map(prev).set(datasetId, report);
        });
      },
      // oxlint-disable-next-line react/preserve-manual-memoization -- see the comment above.
      [setReportsByDataset],
    ),
    completeFor = (datasetId: string) => {
      const report = reportsByDataset.get(datasetId);
      return report !== undefined && report.complete;
    },
    rowsFor = (datasetId: string) => {
      const report = reportsByDataset.get(datasetId);
      return report === undefined ? [] : report.rows;
    },
    allComplete = datasetIds.every(completeFor),
    geometries = allComplete ? datasetIds.flatMap(rowsFor) : undefined,
    anyRows = datasetIds.some((datasetId) => rowsFor(datasetId).length > 0),
    servedGeometries = anyRows ? datasetIds.flatMap(rowsFor) : undefined;

  return {
    geometries,
    loaders: datasetIds.map((datasetId) => (
      <PgGeometriesLoader key={datasetId} datasetId={datasetId} onLoaded={handleLoaded} />
    )),
    servedGeometries,
  };
}

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";
import type { DatasetGeometryType } from "#/lib/store/datasets";
import { liveDatasetIdsQueryOptions, liveViewRowsQueryOptions } from "#/lib/store/views";
import { liveRowsToEntries } from "#/lib/views/live-rows";

import { loadPgGeometryRows, subscribePgGeometryRows } from "../lib/pg-geometry-rows-client";
import type { PgGeometryRowsWorkerOutbound } from "../lib/pg-geometry-rows.worker";
import { pgWorkerRowToLayerRow, type PgResolvedGeometryRow } from "./pg-layer-rows";

/**
 * The Postgres half of the workspace's geometry fan-out ([remedies 1] /
 * #287 edition) — the `useGeometriesBySchemas` pattern (the seam's reactive
 * loader), now riding the row-path WORKER
 * (`../lib/pg-geometry-rows.worker.ts`): one component per dataset, each
 * driving the worker's cursor-chained pass over `dataset_rows_for_tiles`
 * (design §5.5 — the one read that pulls coordinate payloads), with
 * paging, signed-URL payload fetches, and parsing ALL off the main thread.
 * Pages arrive as PARSED geometry objects (structured clone across
 * `postMessage` — ADR 0025's hand-off; the superseded path paid a
 * main-thread `res.json()` per page, a per-row `JSON.stringify` into
 * `geometryJson`, and a per-row re-parse in `useResolvedGeometries`).
 *
 * The report contract is unchanged: partial rows stream as pages land
 * (trailing-edge debounced, the #186 rule — one source rebuild per
 * report), `complete` only after a full pass (cursor-chained to
 * exhaustion — `nextCursor === null`), latching on the first finished
 * pass so a mounted map never re-skeletons across background re-reads.
 *
 * The TanStack query wrapper exists for its CACHE/invalidation semantics,
 * not its data: the key is unchanged
 * (`["pg:geometries","rowsForTiles",…]`), so the entry form's
 * `invalidateQueries({ queryKey: ["pg:geometries"] })` re-runs the pass
 * after an edit exactly as it re-paged the old `useInfiniteQuery`.
 * `runId` tokens (per queryFn run) drop stragglers from a superseded
 * pass: the worker aborts the old run between pages, and any page that
 * slipped out before the abort carried the old token.
 */

/** Minimum gap between partial-pass reports from one loader (the #186 rule — one source rebuild per report). */
const GEOMETRY_REPORT_INTERVAL_MS = 250;

/** One dataset's live geometry-loading state, as the Convex loader reports it. */
export interface PgGeometriesReport {
  complete: boolean;
  rows: DatasetGeometryRow[];
}

/** The loader's page width — the tile feed's default (§5.5), not a reactive-layer width. The worker sizes the ACTUAL take per dataset by `maxGeometryRowBytes` (#183). */
export const PG_LOADER_PAGE_ROWS = 5000;

/**
 * Loads one PG dataset's geometry rows (the worker streams every page of
 * the tile feed) and reports progress up via `onLoaded` as it arrives.
 * Renders nothing. Completeness latching mirrors `SchemaGeometriesLoader`
 * (dataset-rows-react): `complete` flips on the first finished pass and
 * stays up, so a mounted map never re-skeletons.
 */
export function PgGeometriesLoader({
  datasetId,
  onLoaded,
}: {
  datasetId: string;
  onLoaded: (datasetId: string, report: PgGeometriesReport | undefined) => void;
}) {
  const rowsRef = useRef<PgResolvedGeometryRow[]>([]),
    completedRef = useRef(false),
    lastReportRef = useRef(0),
    runIdRef = useRef(0),
    timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The component-lifetime subscription: routes worker events for this
  // dataset into accumulation + reporting, dropping any whose runId isn't
  // the live pass's (a superseded run's straggler).
  useEffect(() => {
    const report = (event: PgGeometryRowsWorkerOutbound) => {
      if (event.type !== "page" && event.type !== "load-error") {
        return;
      }
      if (event.runId !== runIdRef.current) {
        return;
      }
      if (event.type === "load-error") {
        // Parity with the old query-error behavior: the pass dies, the
        // loader never reports, the map's loading gates hold. The worker
        // logged nothing here — the console is the surface.
        console.error(`[pg-geometry-rows] ${datasetId}: ${event.message}`);
        return;
      }
      const mapped = event.rows.map((row) => pgWorkerRowToLayerRow(row, datasetId));
      rowsRef.current = [...rowsRef.current, ...mapped];
      if (event.nextCursor === null) {
        completedRef.current = true;
      }
      const rows = rowsRef.current,
        complete = completedRef.current,
        flush = () => {
          lastReportRef.current = Date.now();
          onLoaded(datasetId, { complete, rows });
        };
      const wait = lastReportRef.current + GEOMETRY_REPORT_INTERVAL_MS - Date.now();
      if (complete || wait <= 0) {
        flush();
        return;
      }
      const timer = setTimeout(() => {
        flush();
      }, wait);
      timersRef.current.push(timer);
    };
    const unsubscribe = subscribePgGeometryRows(datasetId, report);
    return () => {
      unsubscribe();
      for (const timer of timersRef.current) {
        clearTimeout(timer);
      }
      timersRef.current = [];
    };
  }, [datasetId, onLoaded]);

  // The invalidation carrier: the key is the OLD useInfiniteQuery's, so
  // existing `invalidateQueries({ queryKey: ["pg:geometries"] })` calls
  // re-run the pass. Each run resets accumulation (fresh rows underneath)
  // — but NOT the completeness latch (a re-read must not re-skeleton a
  // mounted map; the latch keeps its first-pass value).
  useQuery({
    queryKey: ["pg:geometries", "rowsForTiles", { datasetId, limit: PG_LOADER_PAGE_ROWS }],
    queryFn: async ({ signal }) => {
      runIdRef.current += 1;
      rowsRef.current = [];
      loadPgGeometryRows(datasetId, runIdRef.current);
      // TanStack Query rejects an `undefined` result, so resolve with null.
      return await new Promise<null>((resolve, reject) => {
        const expected = runIdRef.current,
          unsubscribe = subscribePgGeometryRows(datasetId, (event) => {
            if (
              (event.type === "page" && event.nextCursor === null && event.runId === expected) ||
              (event.type === "load-error" && event.runId === expected)
            ) {
              unsubscribe();
              if (event.type === "load-error") {
                reject(new Error(event.message));
              } else {
                resolve(null);
              }
            }
          });
        signal.addEventListener("abort", () => {
          unsubscribe();
          reject(new Error("Geometry pass cancelled."));
        });
      });
    },
    refetchOnWindowFocus: false,
  });

  return null;
}

/**
 * A LIVE view's geometry rows (issue #305): no saved rows, no worker pass and
 * no tile archive — one capped server read (the same one the table uses, so
 * the query cache serves both), reported as a completed pass. The server's
 * row cap is the "cap rule"; the viewport is applied by the map downstream
 * exactly as for any row-path layer.
 */
export function PgLiveGeometriesLoader({
  datasetId,
  onLoaded,
}: {
  datasetId: string;
  onLoaded: (datasetId: string, report: PgGeometriesReport | undefined) => void;
}) {
  const query = useQuery(liveViewRowsQueryOptions(datasetId));
  const live = query.data;
  useEffect(() => {
    if (live === undefined) {
      return;
    }
    const entries = liveRowsToEntries(datasetId, live.rows);
    const rows: PgResolvedGeometryRow[] = [];
    for (const [index, row] of live.rows.entries()) {
      const geom = row.geom;
      const entry = entries[index];
      if (
        entry !== undefined &&
        typeof geom === "object" &&
        geom !== null &&
        "type" in geom &&
        typeof geom.type === "string"
      ) {
        rows.push(
          pgWorkerRowToLayerRow(
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- GeoJSON type names are the PostGIS union.
            { entryId: entry.id, geometry: geom, type: geom.type as DatasetGeometryType },
            datasetId,
          ),
        );
      }
    }
    onLoaded(datasetId, { complete: true, rows });
  }, [datasetId, live, onLoaded]);
  useEffect(() => {
    if (query.isError) {
      console.error(`[live-view] ${datasetId}: ${query.error.message}`);
    }
  }, [datasetId, query.isError, query.error]);
  return null;
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
  /** How many datasets finished a full paging pass (the "N of M layers" progress, #284). */
  completedCount: number;
  /** The row-path dataset count the completed fraction is out of. */
  datasetCount: number;
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
    // Which of these datasets are live views (read through the server, not
    // the worker). Loaders wait for the answer so a live view never starts a
    // doomed worker pass over zero saved rows.
    liveQuery = useQuery(liveDatasetIdsQueryOptions(datasetIds)),
    liveIds = liveQuery.data,
    liveKnown = datasetIds.length === 0 || !liveQuery.isPending,
    allComplete = datasetIds.every(completeFor),
    geometries = allComplete ? datasetIds.flatMap(rowsFor) : undefined,
    anyRows = datasetIds.some((datasetId) => rowsFor(datasetId).length > 0),
    servedGeometries = anyRows ? datasetIds.flatMap(rowsFor) : undefined;

  return {
    geometries,
    loaders: liveKnown
      ? datasetIds.map((datasetId) =>
          liveIds !== undefined && liveIds.includes(datasetId) ? (
            <PgLiveGeometriesLoader
              key={`live:${datasetId}`}
              datasetId={datasetId}
              onLoaded={handleLoaded}
            />
          ) : (
            <PgGeometriesLoader key={datasetId} datasetId={datasetId} onLoaded={handleLoaded} />
          ),
        )
      : [],
    servedGeometries,
    completedCount: datasetIds.filter(completeFor).length,
    datasetCount: datasetIds.length,
  };
}

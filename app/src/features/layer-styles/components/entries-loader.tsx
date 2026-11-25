import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { applyEntryRowSpecs, ENTRIES_PAGE_SIZE } from "#/lib/dataset-rows";
import { listPageQueryOptions, type EntriesPage, type EntryRow } from "#/lib/store/entries";

/**
 * The layer-styles field loader — the `useEntryRowsBySchemas` pattern
 * (the popup executor's join-side reader) running on the entries store: one
 * component per dataset, each PAGING the dataset's entry rows
 * (plain PostgREST keyset over `(created_at, id)` — the seam's bulk path,
 * NOT `search_entries`) and reporting {complete, rows}: partial rows stream as pages land,
 * `complete` only after a full pass (`nextCursor === null`).
 *
 * Rows pass through the seam's `applyEntryRowSpecs` once per page arrival
 * (identity until stage 5's specs exist) and report the store's rows
 * directly, so the style join reads one row type everywhere.
 * `enabled: false` reports undefined AND un-latches complete —
 * the reopened-popup rule, unchanged.
 */

/** One dataset's live entry-loading state. */
export interface EntriesReport {
  complete: boolean;
  rows: EntryRow[];
}

/** Loads one dataset's ENTRY rows and reports progress up. Renders nothing. */
export function EntriesLoader({
  datasetId,
  enabled,
  onLoaded,
}: {
  datasetId: string;
  enabled: boolean;
  onLoaded: (datasetId: string, report: EntriesReport | undefined) => void;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]),
    results = useQueries({
      queries: cursors.map((cursor) =>
        listPageQueryOptions({ cursor, datasetId, numItems: ENTRIES_PAGE_SIZE }),
      ),
    }),
    lastResult: UseQueryResult<EntriesPage> | undefined = results[results.length - 1],
    lastPage = lastResult === undefined ? undefined : lastResult.data,
    completedRef = useRef(false),
    rowsRef = useRef<EntryRow[]>([]);

  // The cursor chain adjusts SYNCHRONOUSLY DURING RENDER (the
  // `useAllPaginated` pattern — packages/json-cms/src/react/lib/
  // all-paginated.ts:120: state that a render's own inputs call for changes
  // before committing, never in an effect — no cascading render).
  const expectedCursors = (() => {
      if (!enabled) {
        return RESET_CURSORS;
      }
      if (lastPage === undefined) {
        return cursors;
      }
      if (lastPage.nextCursor === null) {
        return cursors;
      }
      const last = cursors[cursors.length - 1];
      return last === lastPage.nextCursor ? cursors : [...cursors, lastPage.nextCursor];
    })(),
    chainChanged = expectedCursors !== cursors;
  if (chainChanged) {
    setCursors(expectedCursors);
  }

  useEffect(() => {
    if (!enabled) {
      completedRef.current = false;
      rowsRef.current = [];
      onLoaded(datasetId, undefined);
      return;
    }
    if (lastPage === undefined || chainChanged) {
      return;
    }
    if (lastPage.nextCursor === null) {
      completedRef.current = true;
    }
    const existingIds = new Set(rowsRef.current.map((row) => row.id)),
      freshRows = applyEntryRowSpecs(lastPage.rows).filter((row) => !existingIds.has(row.id));
    rowsRef.current = [...rowsRef.current, ...freshRows];
    onLoaded(datasetId, { complete: completedRef.current, rows: rowsRef.current });
  }, [chainChanged, datasetId, enabled, lastPage, onLoaded]);

  return null;
}

/** The fresh chain a disabled loader resets to (stable reference for the render-adjust bail-out). */
const RESET_CURSORS: Array<string | null> = [null];

/**
 * Fan-out loader for several PG datasets' ENTRY rows — the
 * `useEntryRowsBySchemas` shape (one stable component per dataset), with
 * the same reference-stable `onLoaded` bail-out dedupe. `reportsBySchema`
 * is the live state map — a dataset absent from it (or undefined) has not
 * completed a pass yet.
 */
export function useEntryRowsBySchemas(
  datasetIds: string[],
  enabled: boolean,
): {
  loaders: ReactNode[];
  reportsBySchema: globalThis.Map<string, EntriesReport | undefined>;
} {
  const [reportsBySchema, setReportsBySchema] = useState<
      globalThis.Map<string, EntriesReport | undefined>
    >(() => new globalThis.Map()),
    handleEntriesLoaded = useCallback(
      (datasetId: string, report: EntriesReport | undefined) => {
        setReportsBySchema((prev) => {
          const existing = prev.get(datasetId);
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
      [setReportsBySchema],
    );

  return {
    loaders: datasetIds.map((datasetId) => (
      <EntriesLoader
        key={datasetId}
        datasetId={datasetId}
        enabled={enabled}
        onLoaded={handleEntriesLoaded}
      />
    )),
    reportsBySchema,
  };
}

import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { applyEntryRowSpecs, ENTRIES_PAGE_SIZE } from "#/lib/dataset-rows-pg";
import { listPageQueryOptions, type EntriesPage, type EntryRow } from "#/lib/store/entries";

/**
 * The Postgres half of the layer-styles field loader — the
 * `useEntryRowsBySchemas` pattern (dataset-rows-react's `SchemaEntriesLoader`
 * fan-out, the popup executor's join-side reader) running on the entries
 * store: one component per dataset, each PAGING the dataset's entry rows
 * (plain PostgREST keyset over `(created_at, id)` — the seam's bulk path,
 * NOT `search_entries`) and reporting {complete, rows} exactly like the
 * Convex loader: partial rows stream as pages land, `complete` only after a
 * full pass (`nextCursor === null`).
 *
 * Rows pass through the seam's `applyEntryRowSpecs` once per page arrival
 * (identity until stage 5's specs exist), and report in the seam's row
 * shape (`pgEntryToEntryRow`) so the style join reads one row type on both
 * backends. `enabled: false` reports undefined AND un-latches complete —
 * the reopened-popup rule, unchanged.
 */

/** One dataset's live entry-loading state (the `SchemaEntriesReport` shape). */
export interface PgEntriesReport {
  complete: boolean;
  rows: DatasetEntryRow[];
}

/** Loads one PG dataset's ENTRY rows and reports progress up. Renders nothing. */
export function PgEntriesLoader({
  datasetId,
  enabled,
  onLoaded,
}: {
  datasetId: string;
  enabled: boolean;
  onLoaded: (datasetId: string, report: PgEntriesReport | undefined) => void;
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
    rowsRef = useRef<DatasetEntryRow[]>([]);

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
    const existingIds = new Set(rowsRef.current.map((row) => row._id)),
      // The spec pass runs on the STORE rows (its native shape), then each
      // result lifts into the seam row the style join reads.
      freshRows = applyEntryRowSpecs(lastPage.rows)
        .map(pgEntryRowOf)
        .filter((row) => !existingIds.has(row._id));
    rowsRef.current = [...rowsRef.current, ...freshRows];
    onLoaded(datasetId, { complete: completedRef.current, rows: rowsRef.current });
  }, [chainChanged, datasetId, enabled, lastPage, onLoaded]);

  return null;
}

/** The fresh chain a disabled loader resets to (stable reference for the render-adjust bail-out). */
const RESET_CURSORS: Array<string | null> = [null];

/** The store's `EntryRow` as the seam row the style join reads (`_id`/`schemaId` re-keyed — mirrors `pgEntryToEntryRow` in the maps feature; the features are mutually private per ADR 0014, so the ten-line lift lives on both sides). */
function pgEntryRowOf(row: EntryRow): DatasetEntryRow {
  return {
    _creationTime: 0,
    _id: row.id,
    data: row.data,
    schemaId: row.datasetId,
  };
}

/**
 * Fan-out loader for several PG datasets' ENTRY rows — the
 * `useEntryRowsBySchemas` shape (one stable component per dataset), with
 * the same reference-stable `onLoaded` bail-out dedupe. `reportsBySchema`
 * is the live state map — a dataset absent from it (or undefined) has not
 * completed a pass yet.
 */
export function usePgEntryRowsBySchemas(
  schemaIds: string[],
  enabled: boolean,
): {
  loaders: ReactNode[];
  reportsBySchema: globalThis.Map<string, PgEntriesReport | undefined>;
} {
  const [reportsBySchema, setReportsBySchema] = useState<
      globalThis.Map<string, PgEntriesReport | undefined>
    >(() => new globalThis.Map()),
    handleEntriesLoaded = useCallback(
      (schemaId: string, report: PgEntriesReport | undefined) => {
        setReportsBySchema((prev) => {
          const existing = prev.get(schemaId);
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
      [setReportsBySchema],
    );

  return {
    loaders: schemaIds.map((schemaId) => (
      <PgEntriesLoader
        key={schemaId}
        datasetId={schemaId}
        enabled={enabled}
        onLoaded={handleEntriesLoaded}
      />
    )),
    reportsBySchema,
  };
}

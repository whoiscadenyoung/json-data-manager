import { useAllPaginated } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "#convex/_generated/api";

// `listGeometries` is paginated (see its doc comment in the component) — the
// per-item shape is `PaginationResult["page"][number]`.
export type GeometryEntry = FunctionReturnType<typeof api.geometries.list>["page"][number];

/**
 * One schema's live geometry-loading state, as `SchemaGeometriesLoader`
 * reports it: `rows` are the pages fetched so far (growing as the pass
 * streams, final once `complete`), and `complete` is true only after a FULL
 * pagination pass — `status === "Exhausted"`.
 */
export interface SchemaGeometriesReport {
  complete: boolean;
  rows: GeometryEntry[];
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
    completedRef = useRef(false);
  useEffect(() => {
    if (status === "Exhausted") {
      completedRef.current = true;
    }
    onLoaded(schemaId, { complete: completedRef.current, rows: results });
  }, [schemaId, status, results, onLoaded]);
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
  geometries: GeometryEntry[] | undefined;
  servedGeometries: GeometryEntry[] | undefined;
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

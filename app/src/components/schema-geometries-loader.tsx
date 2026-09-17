import { useAllPaginated } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "#convex/_generated/api";

// `listGeometries` is paginated (see its doc comment in the component) — the
// per-item shape is `PaginationResult["page"][number]`.
export type GeometryEntry = FunctionReturnType<typeof api.geometries.list>["page"][number];

/**
 * Loads one schema's geometries (every page — see `useAllPaginated`) and
 * reports them up via `onLoaded` whenever they change. Renders nothing.
 *
 * A schema counts as loaded only after a FULL pass — pagination reached
 * `"Exhausted"`. `useAllPaginated`'s `isLoading` drops as soon as the first
 * page lands (its accumulated results are non-empty), and reporting then
 * would latch every consumer's completeness gate after one round trip while
 * the remaining pages are still streaming. Latched on the first completed
 * pass: a live re-read flips `status` back while `useAllPaginated` keeps
 * serving the last complete snapshot, so the loader keeps reporting that
 * snapshot instead of flickering back to `undefined` — which is what lets a
 * mounted map stay mounted across background re-reads.
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
  onLoaded: (schemaId: string, geometries: GeometryEntry[] | undefined) => void;
}) {
  const { results, status } = useAllPaginated(api.geometries.list, { schemaId }),
    completedRef = useRef(false);
  useEffect(() => {
    if (status === "Exhausted") {
      completedRef.current = true;
    }
    onLoaded(schemaId, completedRef.current ? results : undefined);
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
 * least one full pass, then one flat array across all schemas, and
 * `servedGeometries`, which additionally serves the already-completed
 * schemas' rows while a NEWLY added schema streams in (only `undefined`
 * before the first schema completes at all) — a consumer
 * that keeps rendering with it instead of gating on `geometries` keeps its
 * mounted state (e.g. a Map's camera) across layer changes.
 */
export function useGeometriesBySchemas(schemaIds: string[]): {
  geometries: GeometryEntry[] | undefined;
  servedGeometries: GeometryEntry[] | undefined;
  loaders: React.ReactNode[];
} {
  const [geometriesBySchema, setGeometriesBySchema] = useState<
      globalThis.Map<string, GeometryEntry[] | undefined>
    >(() => new globalThis.Map()),
    // Must be reference-stable across renders (hence `useCallback` with an
    // empty dep array — the body only closes over the stable `useState`
    // setter): `SchemaGeometriesLoader` depends on `onLoaded` inside its own
    // `useEffect`, so a fresh function identity here on every render would
    // re-fire that effect every time regardless of whether the underlying
    // geometries actually changed, cascading into a `setState`-in-`useEffect`
    // loop across every mounted loader ("Maximum update depth exceeded").
    handleGeometriesLoaded = useCallback(
      (schemaId: string, loaded: GeometryEntry[] | undefined) => {
        setGeometriesBySchema((prev) => {
          const existing = prev.get(schemaId);
          // Bail out of the update entirely when nothing changed (covers
          // the common case of a loader re-reporting the same `undefined`
          // while still loading) — `new Map(prev)` always returns a new
          // reference, so skipping it here is what actually breaks the
          // loop, not just `handleGeometriesLoaded`'s own identity.
          if (existing === loaded) {
            return prev;
          }
          return new globalThis.Map(prev).set(schemaId, loaded);
        });
      },
      // `setGeometriesBySchema` is a useState setter — stable for the
      // component's lifetime, so the callback identity is too.
      [setGeometriesBySchema],
    );

  const geometries = schemaIds.every((schemaId) => geometriesBySchema.get(schemaId) !== undefined)
    ? schemaIds.flatMap((schemaId) => geometriesBySchema.get(schemaId) ?? [])
    : undefined;

  const loadedLists = schemaIds
      .map((schemaId) => geometriesBySchema.get(schemaId))
      .filter((loaded) => loaded !== undefined),
    servedGeometries =
      schemaIds.length === 0 ? [] : loadedLists.length === 0 ? undefined : loadedLists.flat();

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

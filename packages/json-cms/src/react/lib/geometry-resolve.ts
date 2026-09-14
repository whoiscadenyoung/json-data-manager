"use client";

import { useEffect, useMemo, useState } from "react";

import type { Geometry } from "../../shared/geojson/types.js";

/** The subset of `GeometryDoc` this module needs to resolve a row to an actual `Geometry`. */
export interface ResolvableGeometryRow {
  _id: string;
  geometryJson?: string;
  geometryUrl?: string;
}

// Module-level cache, keyed by URL. A `geometryUrl` is a stable Convex
// storage URL for one specific, immutable blob (a geometry document's
// storage-backed value is only ever replaced wholesale via a fresh URL, never
// mutated in place) — so caching a fetch by URL is always safe, and lets
// every consumer (e.g. both `EntriesMap` and `DatasetsMap` resolving the same
// underlying rows) share one fetch instead of re-requesting the same blob.
const urlCache = new Map<string, Promise<Geometry>>();

async function fetchGeometry(url: string): Promise<Geometry> {
  const cached = urlCache.get(url);
  if (cached !== undefined) {
    return cached;
  }
  const pending = fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch geometry (HTTP ${res.status}).`);
      }
      return (await res.json()) as Geometry;
    })
    .catch((err: unknown) => {
      urlCache.delete(url); // Don't poison the cache with a failed fetch — allow a later retry.
      throw err instanceof Error ? err : new Error("Failed to fetch geometry.");
    });
  urlCache.set(url, pending);
  return pending;
}

/** Rows whose geometry is stored externally (only `geometryUrl` set) and so need a `fetch` to resolve. */
function urlOnlyRows<T extends ResolvableGeometryRow>(rows: T[]): Array<{ id: string; url: string }> {
  return rows.flatMap((row) => {
    if (row.geometryJson !== undefined || row.geometryUrl === undefined) {
      return [];
    }
    return [{ id: row._id, url: row.geometryUrl }];
  });
}

/**
 * Resolves a list of geometry rows (as returned by `listGeometries` /
 * `listGeometriesByCollection`) into actual `Geometry` objects, keyed by
 * `_id`. Most rows resolve synchronously from `geometryJson` — the common
 * case, a geometry small enough that the server stored it inline; that part
 * is plain derived state, computed during render. A row with `geometryUrl`
 * instead (a geometry too large to fit in one Convex document) needs a
 * client-side `fetch`, which — as a genuine side effect — runs in an
 * `useEffect`, cached by URL, and merged into the result as each one
 * resolves rather than waiting on all of them together.
 */
export function useResolvedGeometries<T extends ResolvableGeometryRow>(
  rows: T[],
): Map<string, Geometry> {
  const inlineResolved = useMemo(() => {
      const map = new Map<string, Geometry>();
      for (const row of rows) {
        if (row.geometryJson !== undefined) {
          try {
            map.set(row._id, JSON.parse(row.geometryJson) as Geometry);
          } catch {
            // Malformed inline JSON shouldn't happen (written by the
            // server), but skip rather than crash the whole map over one bad row.
          }
        }
      }
      return map;
    }, [rows]),
    [fetched, setFetched] = useState<Map<string, Geometry>>(new Map());

  // `rows` is a fresh array on every render (it's derived/flat-mapped by
  // callers), so depending on it directly would re-run this effect — and
  // re-issue every pending fetch — on every render regardless of whether the
  // actual set of URLs changed, which cascades into an infinite render loop
  // once `setFetched` below triggers the next one. Depend on a stable,
  // content-derived key instead so the effect only re-runs when the set of
  // URLs to resolve has actually changed.
  const pendingKey = useMemo(
    () =>
      urlOnlyRows(rows)
        .map((row) => `${row.id}:${row.url}`)
        .join("|"),
    [rows],
  );

  useEffect(() => {
    let cancelled = false;
    const pending = urlOnlyRows(rows);

    for (const row of pending) {
      void fetchGeometry(row.url)
        .then((geometry) => {
          if (!cancelled) {
            // Bail out when this id already resolved to the same fetch
            // result — `new Map(prev)` always returns a new reference, and
            // without this check a cache-hit re-resolution (harmless on its
            // own) would still trigger a state update, a re-render, and
            // (upstream) another pass through this same effect.
            setFetched((prev) => (prev.get(row.id) === geometry ? prev : new Map(prev).set(row.id, geometry)));
          }
        })
        .catch(() => {
          // Leave this row unresolved; everything else still renders.
        });
    }

    return () => {
      cancelled = true;
    };
    // `pendingKey` (not `rows`) is the real dependency — see its own comment
    // above; `rows`/`urlOnlyRows(rows)` inside this effect always reflect
    // the latest render regardless, since closures aren't stale here (the
    // effect re-running is keyed off content, not identity).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  return useMemo(() => {
    if (fetched.size === 0) {
      return inlineResolved;
    }
    const merged = new Map(inlineResolved);
    for (const [id, geometry] of fetched) {
      merged.set(id, geometry);
    }
    return merged;
  }, [inlineResolved, fetched]);
}

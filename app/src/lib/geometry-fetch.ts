/**
 * The row-path geometry feed's shared mechanics ([remedies 1] / #287) — the
 * pieces both off-main-thread consumers (the row-path render worker and the
 * tile-archive build worker) need: a page of `dataset_rows_for_tiles` whose
 * width is sized by the dataset's `maxGeometryRowBytes` (#183's take-sizing
 * mechanism, previously applied on no PG read path), and one row's payload
 * resolution (inline jsonb is already parsed by the RPC response's
 * `res.json()`; storage-backed rows sign a URL and fetch).
 *
 * Worker-side module: every store call takes the override client (the
 * cookie-bound browser client is a main-thread object), and nothing here
 * touches React or a component barrel.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createGeometrySourceUrl,
  DEFAULT_GEOMETRY_ROWS_LIMIT,
  rowsForTiles,
  type GeometryRow,
} from "#/lib/store/geometries";

/**
 * Rows requested per geometry page when the caller doesn't pin one (the
 * `dataset_rows_for_tiles` default, design §5.5).
 */
export const DEFAULT_GEOMETRY_PAGE_ROWS = DEFAULT_GEOMETRY_ROWS_LIMIT;

/**
 * The response-size budget the ARCHIVE build's fetch phase aims to stay
 * under: page width = budget ÷ `maxGeometryRowBytes`, clamped to
 * [1, DEFAULT]. A 3 MB-per-row jurisdiction dataset pages ~5 rows at a
 * time; a 59-byte point dataset pages the full 5000.
 * (`maxGeometryRowBytes` is the dataset's MAXIMUM row — pages land at or
 * under the budget, never over.) Build latency tolerates the extra round
 * trips (a debounced background job with progress reporting); a
 * multi-gigabyte single response does not.
 */
export const GEOMETRY_PAGE_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * The take width for a dataset whose per-row byte estimate is known, under
 * the build-phase payload budget — null (pre-backfill) keeps the default
 * width. Used ONLY by the archive build's fetch phase: build latency
 * tolerates the extra round trips (a debounced background job with
 * progress reporting), while a multi-gigabyte single response does not.
 * The row-path loader deliberately does NOT size its takes — its pages
 * feed a worker-side parse, and per-page map-land updates are the
 * O(pages²) main-thread cost ADR 0025 defers.
 */
export function geometryTakeRowsFor(maxGeometryRowBytes: number | null): number {
  if (maxGeometryRowBytes === null || maxGeometryRowBytes <= 0) {
    return DEFAULT_GEOMETRY_PAGE_ROWS;
  }
  return Math.max(
    1,
    Math.min(
      DEFAULT_GEOMETRY_PAGE_ROWS,
      Math.floor(GEOMETRY_PAGE_PAYLOAD_BYTES / maxGeometryRowBytes),
    ),
  );
}

/**
 * One page of the dataset's geometry rows at an explicit width — the
 * worker-side building block the cursor loop consumes (`nextCursor === null`
 * is exhaustion, the §5 completeness rule the loader's `complete` latch and
 * the build worker's exhaustion check both ride).
 */
export async function geometryRowsPageSized(
  supabase: SupabaseClient,
  datasetId: string,
  cursor: string | null,
  limit: number,
): Promise<{ nextCursor: string | null; rows: GeometryRow[] }> {
  return await rowsForTiles({ cursor, datasetId, limit }, { supabase });
}

/**
 * One row's GeoJSON for RENDER: inline `geometry` passes through (already a
 * parsed object off the RPC response); a storage-backed row signs its URL
 * and parses the payload. Throws on a failed fetch — callers decide the
 * posture (the render worker catches per row; the build worker fails the
 * build loudly).
 */
export async function resolveGeometryRowForRender(
  supabase: SupabaseClient,
  row: Pick<GeometryRow, "geometry" | "sourcePath">,
): Promise<unknown> {
  if (row.geometry !== null && row.geometry !== undefined) {
    return row.geometry;
  }
  if (row.sourcePath === null || row.sourcePath === undefined) {
    return undefined;
  }
  const url = await createGeometrySourceUrl(supabase, row.sourcePath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch geometry (HTTP ${response.status}).`);
  }
  return await response.json();
}

/**
 * The reactive feeds for the PG tile pipeline (the hooks half of
 * `./pg-tile-archives.ts`, kept out of that module so the worker can import
 * the core without React): the PG dataset summaries (the staleness
 * triggers', the decision's, and the pin's shared input — one TanStack
 * subscription, deduped by key across every mounted consumer) and the
 * signed-archive-URL metas (the `api.cms.tile_archives.metas` analogue:
 * one query for N datasets, the hook-rules-safe fan-out).
 *
 * Loading states are two-valued ON PURPOSE: `undefined` means "still
 * loading" (a fresh archive candidate holds `pending` rather than flashing
 * the row path), while a LOADED map that lacks a dataset means "no servable
 * archive" (rows). The Convex decision distinguishes exactly the same two
 * states (`meta === undefined` vs `meta === null`).
 */

import { useQuery } from "@tanstack/react-query";

import { listSummariesQueryOptions, type DatasetSummaryRow } from "#/lib/store/datasets";

import { pgTileArchiveMetasOf, type PgTileArchiveMeta } from "./pg-tile-archives";

/** The PG dataset summaries (`pg:datasets`/`listSummaries`), or undefined while loading. */
export function usePgDatasetSummaries(): DatasetSummaryRow[] | undefined {
  const query = useQuery(listSummariesQueryOptions());
  return query.data;
}

/** The stable empty metas map (loaded, nothing servable) for zero-id callers. */
const EMPTY_PG_METAS: globalThis.Map<string, PgTileArchiveMeta> = new globalThis.Map();

/**
 * Signed archive URLs for the given PG geospatial datasets, keyed by dataset
 * id; `undefined` while the query is in flight. Only current-format,
 * version-matched archives appear (the feed's filter — see
 * `pgTileArchiveMetasOf`), so a missing key after load = rows, mirroring the
 * Convex metas query's null. Errors read as loaded-and-empty (rows; the next
 * summaries change refires the query).
 */
export function usePgTileArchiveMetas(
  datasetIds: ReadonlyArray<string>,
): globalThis.Map<string, PgTileArchiveMeta> | undefined {
  const query = useQuery({
    enabled: datasetIds.length > 0,
    queryFn: async () => await pgTileArchiveMetasOf(datasetIds),
    queryKey: ["pg:tile-archives", "metas", datasetIds],
    retry: 1,
  });
  if (datasetIds.length === 0) {
    return EMPTY_PG_METAS;
  }
  const data = query.data;
  if (data === undefined) {
    if (query.isError) {
      // A failed signing read must not hold fresh candidates pending
      // forever — degrade to rows (loaded-and-empty); the next summaries
      // change or remount refires the query.
      return EMPTY_PG_METAS;
    }
    return undefined;
  }
  const metas = new globalThis.Map<string, PgTileArchiveMeta>();
  for (const meta of data) {
    metas.set(meta.datasetId, meta);
  }
  return metas;
}

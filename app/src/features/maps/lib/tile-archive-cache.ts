/**
 * Root manager for the OPFS tile-archive pin. The cache itself (store,
 * eviction, protocol wiring) lives in `@caden/maps/archive-cache`; this
 * module feeds it the live archive metadata from the Postgres store (issue
 * #201) — the pin's machinery (backfill-once, version-keyed files, LRU) is
 * keyed by dataset id.
 */
import {
  getTileArchiveCache,
  unwireProtocolSources,
  wiredSchemaIds,
  wireProtocolSource,
} from "@caden/maps/archive-cache";
import { useEffect, useMemo } from "react";

import { isTileCandidate } from "./tile-archive-state";
import { useTileDatasetSummaries, useTileArchiveMetas } from "./tile-archive-state-react";

/**
 * Mounted once at the app root (next to the rebuild manager): observes every
 * geospatial dataset's archive metadata and drives the pin — backfill new
 * versions, prune superseded/gone ones, enforce the LRU budget. Purely a
 * cache keeper: rendering decisions stay in `layer-source.ts`, builds in
 * `tile-archive.ts`.
 */
export function TileArchiveCacheManager(): null {
  const summaries = useTileDatasetSummaries();
  const geospatialIds = useMemo(
    () => (summaries ?? []).filter((row) => isTileCandidate(row)).map((row) => row.id),
    [summaries],
  );
  const metas = useTileArchiveMetas(geospatialIds);
  useEffect(() => {
    if (metas === undefined) return; // wait for the first observation
    const cache = getTileArchiveCache();
    if (cache === undefined) return;
    void (async () => {
      await cache.init();
      const geospatial = new Set(geospatialIds);
      const wired = new Set(wiredSchemaIds());
      for (const datasetId of wired) {
        // Prune anything that is not a live geospatial pin.
        if (!geospatial.has(datasetId)) {
          // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
          await cache.observeMeta(datasetId, null);
          unwireProtocolSources(datasetId);
        }
      }
      for (const [datasetId, meta] of metas) {
        wireProtocolSource(datasetId, meta.version, meta.url);
        unwireProtocolSources(datasetId, meta.version);
        // oxlint-disable-next-line no-await-in-loop -- sequential pin updates; ordering keeps the backfill generation sane.
        await cache.observeMeta(datasetId, { url: meta.url, version: meta.version });
      }
      // A geospatial PG dataset that LOST its servable archive (stale-on-view
      // flip: the live version moved past the built one) drops out of metas —
      // drop its pin in the same pass.
      for (const datasetId of wired) {
        if (geospatial.has(datasetId) && !metas.has(datasetId)) {
          // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
          await cache.observeMeta(datasetId, null);
          unwireProtocolSources(datasetId);
        }
      }
    })();
  }, [metas, geospatialIds]);
  return null;
}

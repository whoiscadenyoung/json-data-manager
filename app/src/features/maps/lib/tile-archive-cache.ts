/**
 * Root manager for the OPFS tile-archive pin. The cache itself (store,
 * eviction, protocol wiring) lives in `@caden/maps/archive-cache`; this
 * module feeds it the live archive metadata from the Postgres store (issue
 * #201) — the pin's machinery (backfill-once, version-keyed files, LRU) is
 * backend-blind and keyed by dataset id. The Convex feed that ran beside it
 * until the stage-7 disconnect (issue #206) is gone with the provider; pins
 * it left in an existing OPFS cache are pruned on the next boot, since no
 * Convex surface can re-wire them.
 */
import {
  getTileArchiveCache,
  unwireProtocolSources,
  wiredSchemaIds,
  wireProtocolSource,
} from "@caden/maps/archive-cache";
import { useEffect, useMemo } from "react";

import { isPostgresDatasetId } from "#/lib/dataset-source";

import { isPgTileCandidate } from "./pg-tile-archives";
import { usePgTileDatasetSummaries, usePgTileArchiveMetas } from "./pg-tile-archives-react";

/**
 * Mounted once at the app root (next to the rebuild manager): observes every
 * geospatial dataset's archive metadata and drives the pin — backfill new
 * versions, prune superseded/gone ones, enforce the LRU budget. Purely a
 * cache keeper: rendering decisions stay in `layer-source.ts`, builds in
 * `tile-archive.ts`.
 */
export function TileArchiveCacheManager(): null {
  const pgSummaries = usePgTileDatasetSummaries();
  const pgGeospatialIds = useMemo(
    () => (pgSummaries ?? []).filter((row) => isPgTileCandidate(row)).map((row) => row.id),
    [pgSummaries],
  );
  const pgMetas = usePgTileArchiveMetas(pgGeospatialIds);
  useEffect(() => {
    if (pgMetas === undefined) return; // wait for the first observation
    const cache = getTileArchiveCache();
    if (cache === undefined) return;
    void (async () => {
      await cache.init();
      const geospatial = new Set(pgGeospatialIds);
      const wired = new Set(wiredSchemaIds());
      for (const schemaId of wired) {
        // Prune anything that is not a live PG geospatial pin — including the
        // dash-id pins the pre-disconnect Convex feed may have left in an
        // existing OPFS cache (they can never re-wire).
        if (!isPostgresDatasetId(schemaId) || !geospatial.has(schemaId)) {
          // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
          await cache.observeMeta(schemaId, null);
          unwireProtocolSources(schemaId);
        }
      }
      for (const [datasetId, meta] of pgMetas) {
        wireProtocolSource(datasetId, meta.version, meta.url);
        unwireProtocolSources(datasetId, meta.version);
        // oxlint-disable-next-line no-await-in-loop -- sequential pin updates; ordering keeps the backfill generation sane.
        await cache.observeMeta(datasetId, { url: meta.url, version: meta.version });
      }
      // A geospatial PG dataset that LOST its servable archive (stale-on-view
      // flip: the live version moved past the built one) drops out of pgMetas —
      // drop its pin in the same pass.
      for (const schemaId of wired) {
        if (isPostgresDatasetId(schemaId) && geospatial.has(schemaId) && !pgMetas.has(schemaId)) {
          // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
          await cache.observeMeta(schemaId, null);
          unwireProtocolSources(schemaId);
        }
      }
    })();
  }, [pgMetas, pgGeospatialIds]);
  return null;
}

/**
 * Root manager for the OPFS tile-archive pin. The cache itself (store,
 * eviction, protocol wiring) lives in `@caden/maps/archive-cache`; this module
 * feeds it the live archive metadata from Convex.
 */
import {
  getTileArchiveCache,
  unwireProtocolSources,
  wiredSchemaIds,
  wireProtocolSource,
} from "@caden/maps/archive-cache";
import { useQuery } from "convex/react";
import { useEffect, useMemo } from "react";

import { api } from "#convex/_generated/api";

/**
 * Mounted once at the app root (next to the rebuild manager): observes every
 * geospatial dataset's archive metadata and drives the pin — backfill new
 * versions, prune superseded/gone ones, enforce the LRU budget. Purely a
 * cache keeper: rendering decisions stay in `layer-source.ts`, builds in
 * `tile-archive.ts`.
 */
export function TileArchiveCacheManager(): null {
  const schemas = useQuery(api.cms.schemas.listSummaries, { limit: 1000 });
  const geospatialIds = useMemo(
    () =>
      (schemas ?? [])
        .filter((schema) => schema.kind === "geospatial" && schema.geometryType !== undefined)
        .map((schema) => schema._id),
    [schemas],
  );
  const metas = useQuery(
    api.cms.tile_archives.metas,
    geospatialIds.length > 0 ? { schemaIds: geospatialIds } : "skip",
  );
  useEffect(() => {
    if (metas === undefined) return; // wait for the first observation
    const cache = getTileArchiveCache();
    if (cache === undefined) return;
    void (async () => {
      await cache.init();
      // Datasets that left the geospatial set (deleted, or converted away)
      // have no archive pointer anymore — drop their pins.
      if (schemas !== undefined) {
        const geospatial = new Set(geospatialIds);
        for (const schemaId of new Set(wiredSchemaIds())) {
          if (!geospatial.has(schemaId)) {
            // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
            await cache.observeMeta(schemaId, null);
            unwireProtocolSources(schemaId);
          }
        }
      }
      for (const [index, schemaId] of geospatialIds.entries()) {
        const meta = metas[index];
        if (meta === undefined) continue;
        if (meta === null) {
          // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
          await cache.observeMeta(schemaId, null);
          unwireProtocolSources(schemaId);
          continue;
        }
        wireProtocolSource(schemaId, meta.version, meta.url);
        // A version bump wires a new PMTiles instance for the new storage
        // URL; drop the superseded instances (kept out of the protocol map,
        // already-loaded maps are untouched) so they stop accumulating across
        // rebuilds (issue #134).
        unwireProtocolSources(schemaId, meta.version);
        // oxlint-disable-next-line no-await-in-loop -- sequential pin updates; ordering keeps the backfill generation sane.
        await cache.observeMeta(schemaId, { url: meta.url, version: meta.version });
      }
    })();
  }, [schemas, metas, geospatialIds]);
  return null;
}

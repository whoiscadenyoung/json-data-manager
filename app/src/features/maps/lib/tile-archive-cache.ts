/**
 * Root manager for the OPFS tile-archive pin. The cache itself (store,
 * eviction, protocol wiring) lives in `@caden/maps/archive-cache`; this module
 * feeds it the live archive metadata — from Convex, and since stage 2 also
 * from the Postgres store (issue #201): the pin's machinery (backfill-once,
 * version-keyed files, LRU) is backend-blind and keyed by dataset id, whose
 * spaces are disjoint, so both feeds drive the same cache instance without
 * ever colliding.
 */
import {
  getTileArchiveCache,
  unwireProtocolSources,
  wiredSchemaIds,
  wireProtocolSource,
} from "@caden/maps/archive-cache";
import { useQuery } from "convex/react";
import { useEffect, useMemo } from "react";

import { isPostgresDatasetId } from "#/lib/dataset-source";
import { api } from "#convex/_generated/api";

import { isPgTileCandidate } from "./pg-tile-archives";
import { usePgDatasetSummaries, usePgTileArchiveMetas } from "./pg-tile-archives-react";

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
      // have no archive pointer anymore — drop their pins. Only CONVEX ids
      // are prunable here: the wired set is shared with the PG feed below,
      // whose uuid pins answer to the PG observation, never this one.
      if (schemas !== undefined) {
        const geospatial = new Set(geospatialIds);
        for (const schemaId of new Set(wiredSchemaIds())) {
          if (!geospatial.has(schemaId) && !isPostgresDatasetId(schemaId)) {
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

  // --- The Postgres feed (stage 2): same cache, same semantics, uuid ids ---
  const pgSummaries = usePgDatasetSummaries();
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
      // The wired set is SHARED with the Convex feed — only PG ids
      // (uuid origin) may be pruned here, never the Convex feed's pins.
      const geospatial = new Set(pgGeospatialIds);
      const wired = new Set(wiredSchemaIds());
      for (const schemaId of wired) {
        if (isPostgresDatasetId(schemaId) && !geospatial.has(schemaId)) {
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
      // drop its pin the same pass the Convex feed drops `meta === null` ones.
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

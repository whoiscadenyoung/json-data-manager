/** Minimum geometry-payload size a dataset must reach before a tile archive is worth building for it (exported for tests). Below this the existing row-based read path is already cheap enough — SMART's ~13 KB of points would gain nothing from a 256 KB archive. Consumed by the rebuild worker (issue #58 part 3), not by this component. */
export const MAP_TILE_ARCHIVE_MIN_BYTES = 262_144; // 256 KB

/**
 * The tile-archive layout generation this component installs (issue #125's
 * invalidation mechanism — an archive-FORMAT bump, deliberately not a
 * `mapTileCacheVersion` bump: the version counter is per-row data that no
 * code change can retroactively move, while this gate re-reads every
 * install against the current constant). Format 1 is the implicit field-
 * absent era: its builder merged byte-identical tiles into run-length
 * entries across tile-id gaps, leaving tiles unreachable and maps with
 * holes. `setMapTileArchive` stamps the current format on every install,
 * and `getMapTileArchiveMeta` treats anything else as no archive — which
 * reads as "row path only" to consumers. The gate is mirrored into the
 * summary projection (`toSchemaSummary`'s derived
 * `mapTileArchiveFormatCurrent`, computed against this same constant), so
 * the TileArchiveManager's staleness trigger rebuilds a format-gated row
 * and the OPFS pin prunes its stale local copy. Bump this constant
 * whenever a builder change would make old installed archives wrong.
 */
export const MAP_TILE_ARCHIVE_FORMAT = 2;

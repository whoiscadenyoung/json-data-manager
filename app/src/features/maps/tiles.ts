// Tile-archive managers for the app root (ADR 0014). A separate entry from
// `index.ts` so the root bundle never pulls in the map components (MapLibre).
export { TileArchiveManager, ensureMapTileArchive } from "./lib/tile-archive";
export { TileArchiveCacheManager } from "./lib/tile-archive-cache";

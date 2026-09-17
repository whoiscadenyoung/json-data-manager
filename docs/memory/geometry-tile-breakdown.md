---
name: geometry-tile-breakdown
description: 2026-09-17 breakdown of issue #58 into ordered parts #59–#63 with
  per-part decisions; agent-implementable sequence
metadata:
  type: project
---

On 2026-09-17 issue #58 was broken into five ordered, agent-implementable
sub-issues (all labeled `performance`; each self-contained, app stays working
between parts). Tracking comment on #58 links them. Extend
[[geometry-tile-archive-research]] for the underlying research.

- **#59** `packages/geometry-archive` (`@caden/geometry-archive`, modeled on
  `@caden/data-export`): GeoJSON FeatureCollection → geojson-vt → vt-pbf
  (extent 4096) → gzip → PMTiles v3 writer (pure Uint8Array). Roundtrip tests
  against the reference `pmtiles` npm reader; size benchmark target ≤10% of
  GeoJSON bytes. No flat-container fallback code (decision: commit to v3).
- **#60** component schema fields: `mapTileCacheVersion` (absent = 0),
  `mapTileArchiveStorageId/Bytes/MaxZoom`; unconditional version bump helper on
  every geometry-affecting path (same paths as featureCount/boundingBox);
  `setMapTileArchive` internal mutation with **expectedVersion guard** (stale
  rebuild self-discards, deletes incoming blob — correctness lives here, not
  in client debounce); blob delete inside mutation (existing lib.ts:1496
  pattern); `getMapTileArchiveMeta` query returns URL (getUrl works in
  queries); `MAP_TILE_ARCHIVE_MIN_BYTES = 262_144` next to
  GEOMETRY_PAGE_BYTE_BUDGET.
- **#61** app-level `app/src/lib/tile-archive{.ts,.worker.ts}`: worker owns a
  standalone ConvexClient (WebSocket works in workers; fallback = main-thread
  fetch + postMessage transfer), pages geometries.list to Exhausted, builds +
  uploads + installs with version snapshot. Manager: single-flight + ~5s
  debounce; triggers = stale-on-view (authoritative) + import-UI ensure-call.
  **`handleImportComplete` (component/lib.ts:2239) is a server-side workflow
  callback — there is NO client completion hook; the "imports rebuild exactly
  once" property comes from stale-on-view + ensure-call.**
- **#62** register `pmtiles` Protocol via maplibregl.addProtocol once (reader
  = reference impl; writer = ours, roundtrip-tested); source selection helper
  (vector tiles above threshold ∧ archive present, else row path — including
  as fallback until first rebuild lands); consumers layers-map/datasets-map/
  group-map; point datasets render as circle layers from tiles (clustering
  stays row-path-only); chip completeness for tile path = meta-version-
  currency ∧ map-idle — **Exhausted gating stays row-path-only**; hot-swap =
  remove/re-add source, never unmount.
- **#63** OPFS pin: `tile-archives/{schemaId}/{version}.pmtiles`, async OPFS
  API on main thread (addProtocol resolves main-thread; sync handles
  unnecessary), LRU budget 256 MB, prune old versions; TanStack Query
  persister (`@tanstack/react-query` already installed): PersistQueryClient-
  Provider + createAsyncStoragePersister + idb-keyval, **buster = max
  mapTileCacheVersion across schemas**, dehydrate filter = light namespaces
  only (never geometry payloads), gcTime ≥ maxAge (docs gotcha). TanStack DB
  remains an optional future table-path increment, not required.

**Why this order:** #59 de-risks the only genuinely unknown piece (in-repo
PMTiles writing) first, zero app impact; #60 lands all server machinery with no
behavior change; #61 makes archives self-maintaining; #62 is the visible
payoff measured on FY22 (≤5% of 46.55 MB, no main-thread parse, instant
toggles); #63 completes the cache layers (repeat opens = zero bytes).

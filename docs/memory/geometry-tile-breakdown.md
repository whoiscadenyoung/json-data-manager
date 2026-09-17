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

## #59 part-1 status (2026-09-17, merged to `main`)

Library implemented + bun tests green (reference-reader roundtrip, x- and
y-boundaries, leaf-directory split, benchmark), repo oxlint clean; PR opened,
merged, branch deleted per the kickoff DONE list.

- **Measured size (FY22-shaped 450-feature county-road fixture, ~4700
  verts/feature + SS4A property bag):** GeoJSON 50.61 MB → archive 5.07 MB =
  **10.01%** with per-tile gzip. **Part 4 byte targets calibrate on ~10%.**
  (The earlier 7.52% figure was measured on a build with a tile-enumeration
  bug that silently dropped features spanning tile rows; the complete archive
  is ~33% larger. Uncompressed-tile comparison 10.91% is likewise stale —
  gzip-vs-none decision unaffected, not re-measured.)
- **Review-fix 2026-09-17 (y-span enumeration):** `candidateRange` derived
  `y0` from `minLat` and `y1` from `maxLat`, but mercator rows grow southward
  — features crossing a row boundary produced `y0 > y1` and contributed no
  tiles (silently missing data, or "no tiles" on single-feature inputs).
  Fixed to derive the range from `maxLat`→`minLat`; y-boundary tests added.
  Lesson: tile-axis direction must be tested in BOTH axes — the original
  boundary suite only crossed x boundaries at constant latitude.
- **Leaf-directory split now regression-tested:** 20k scattered z12 points
  force root > 16 KB; leaves resolve through the reference reader (was
  implemented but untested).
- **Spec corrections vs kickoff text (validated against the protomaps
  `firenze.pmtiles` sample):** header is **127 bytes** (not 163) and
  positions are **int32 ×1e7 fixed-point** (not float32); **v3 has no EOS
  block** (that was v2). Metadata JSON only needs `vector_layers` (TileJSON
  form); zoom/compression/tileType live in the header (extras in metadata
  are optional).
- **Tile compression decision:** per-tile gzip measured better than none at
  FY22 scale — header `tileCompression=2`, `internalCompression=2`
  (dirs+metadata), `clustered=1`, `tileType=1`.
- **Dependency APIs that shaped the code:** `pmtiles@4.5` reader
  (`getZxy`/`getHeader`/`getMetadata`; `Source` = `getBytes`+`getKey`);
  `geojson-vt@5.0.2` (ESM; `getTile` drills lazily, `tileCoords` only lists
  eagerly-indexed z≤5 tiles → archive enumeration uses per-feature mercator
  bbox + buffer pad instead); `vt-pbf@3.1.3`
  `fromGeojsonVt({"geojson": tile}, {extent: 4096, version: 2})`; decode in
  tests via `@mapbox/vector-tile@3` + `pbf@5` (`PbfReader`, named export).
- **Hilbert codec** transliterated from protomaps and cross-checked against
  `pmtiles.zxyToTileId` (z0–14) + spec table (12/3423/1763 → 19078479).
- **Gotchas hit:** web-mercator y is `0.5 − asinh(tan φ)/(2π)` (÷π breaks
  candidate enumeration); the first directory delta may be 0 (tileId 0 is
  legal), guard is `delta<0 || (i>0 && delta<=0)`; gzipSync is deterministic
  so dedup compares compressed bytes directly; uniform synthetic tiles
  gzip-crush the root directory — force a leaf split with irregular tile
  sizes/positions.

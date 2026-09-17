# Kickoff — Part 4: render maps from tile archives (issue #62)

Part 4 of 5 implementing #58 — the visible payoff, measured on the FY22 Action
Plan dataset (450 features, 46.55 MB of GeoJSON text today). Read the
user-expectation memory entries BEFORE touching map UI; they encode hard-won
user feedback.

## Read first
1. `docs/memory/MEMORY.md`, then **`loading-indicator-ui-expectations.md`** and
   **`ui-polish-expectations.md`** — chips persist until completeness, maps are
   never unmounted/skeletoned mid-session, latch after first complete render
2. `geometry-tile-breakdown.md` (you are #62 — chip semantics + hot-swap rules)
3. Issue **#62** — full design + measured acceptance criteria

**Amend before handing off:** confirm parts 1–3 shipped (protocol name/exports
of `@caden/geometry-archive`, `useMapTileArchiveMeta` signature, manager API,
threshold constant) from package source + memory.

## Part 3 shipped (2026-09-17) — confirm against this before starting

- **Staleness is observable via `mapTileArchiveBuiltVersion`** (part-3
  amendment): `meta.version` = the version the archive was BUILT from (the
  component's `getMapTileArchiveMeta` returns `mapTileArchiveBuiltVersion`;
  part 2 had returned the live counter, which made staleness undetectable).
  Compare `meta.version !== schema.mapTileCacheVersion` → stale.
- **Worker:** `app/src/lib/tile-archive.worker.ts` owns a standalone
  `ConvexClient` (the WebSocket works in worker scope — verified live; NO
  main-thread-fetch fallback was needed). Protocol: inbound `{type:"build",
  schemaId}`; outbound `phase` (fetching/building/uploading/installing) then
  exactly one terminal message (`done` with builtVersion/bytes/maxZoom |
  `stale-discarded` | `skipped` reason not-geospatial/below-threshold).
  Pages `api.geometries.list` to `isDone`, storage-backed rows fetch
  `geometryUrl` directly, threshold check on the exact assembled payload
  BEFORE building, upload via `api.imports.generateUploadUrl`, install via
  `api.tile_archives.install`. Builds serialize on a promise chain.
- **Manager:** `app/src/lib/tile-archive.ts` — `TileArchiveScheduler` (5 s
  trailing debounce keyed by version, single-flight per schema, one queued
  rebuild max, failed builds don't wedge) + `ensureMapTileArchive(schemaId)`
  (skips the debounce; used by the import UI on completion) +
  `useMapTileArchiveManager`/`<TileArchiveManager />` (mounted in
  `__root.tsx`; watches ALL geospatial schemas via `api.schemas.list`:
  stale-on-view + first-build when `mapTileCacheVersion > 0` with no
  archive). `useMapTileArchiveBuildState(schemaId)` (`useSyncExternalStore`)
  exposes idle/scheduled/phase/done/stale-discarded/error for the part-4
  chip; terminal states auto-revert to idle after 4 s.
- **Wrapper:** `app/convex/tile_archives.ts` `install` — runs auth, calls
  `components.jsonCms.lib.setMapTileArchive`, then re-reads
  `getMapTileArchiveMeta` in the same transaction and returns
  `"installed" | "discarded"` (the guard's discard is otherwise
  indistinguishable). Ids are plain strings; the component re-validates.
- **Dev-verified live** (throwaway dataset, deleted after): one build per
  edit burst built at the FINAL version; a mid-build edit self-discarded and
  the queued rebuild converged to fresh; deleteSchema removed the blob
  (404) and the meta.
- The first-build trigger covers datasets whose edits happened before the
  manager existed (version > 0, no archive). Below-threshold datasets
  attempt per edit-burst and skip (≤256 KB fetch — cheap, accepted).

## Task

- **Protocol registration (once)** in `app/src/components/ui/map.tsx` init:
  `maplibregl.addProtocol("pmtiles", protocol.tile)` with the reference
  `pmtiles` npm `Protocol` (reader; roundtrip-tested against our writer in
  part 1).
- **Source selection helper** (e.g. `app/src/lib/layer-source.ts`): dataset
  above `MAP_TILE_ARCHIVE_MIN_BYTES` ∧ archive present ∧ fresh →
  `{kind: "vector", url: "pmtiles://" + meta.url}`; otherwise → today's row
  path (`useGeometriesBySchemas` + loaders). The row path stays the fallback
  for above-threshold datasets whose archive isn't ready or is STALE
  (mid-rebuild) — hot-swaps to tiles when a fresh archive arrives. Note the
  threshold lives in the component (`MAP_TILE_ARCHIVE_MIN_BYTES` in
  `component/lib.ts`, mirrored in `tile-archive.ts`); the app decides from
  the archive's presence + bytes, not by re-deriving the threshold.
- **Wire consumers:** `layers-map.tsx` (+ `routes/maps/$mapId.tsx`),
  `routes/datasets/$schemaId/index.tsx` (`datasets-map.tsx`),
  `group-map.tsx` (+ `routes/groups/$groupId.tsx`). Collection extent maps
  stay bbox-only (#49 — no geometry loads).
- **map.tsx:** accept a vector-tile source alongside existing geojson sources;
  styling mirrors current fill/line/circle. Point datasets above threshold =
  circle layer from tiles; **clustering stays a below-threshold (row-path)
  feature**.
- **Hit-testing:** tiles carry id-only props (`entryId` on every feature) —
  click/hover reports `entryId`; popup/inspect content loads on demand via
  entry queries (#52 direction).
- **Hot-swap on rebuild:** new version/url → remove + re-add source, re-apply
  layers. NEVER unmount the map, never re-skeleton (established philosophy).
  The manager's build-state store (`useMapTileArchiveBuildState`) is
  available if the chip wants a "rebuilding…" phase indicator; it is NOT
  required for completeness gating.
- **Chip/completeness for the tile path:** completeness = archive meta loaded
  ∧ `meta.version` current (compare against `schema.mapTileCacheVersion`) ∧
  map reached `idle` after source added. Do NOT gate on individual tile
  fetches; Exhausted gating stays ROW-PATH-ONLY (`servedGeometries` semantics
  unchanged for those datasets). Below-threshold datasets render exactly as
  today; SMART's 13 KB stays instant via rows.

## Verification (devtools, FY22 Action Plan)
- [ ] Map open: network shows only range requests against the archive —
      target ≤5% of today's 46.55 MB (part 1's measured ratio calibrates this)
- [ ] No main-thread `JSON.parse` of geometry payloads (performance recording)
- [ ] Layer show/hide instant; map never unmounts across toggles/rebuilds
- [ ] Entry edit → rebuild → source hot-swaps without unmount or skeleton
- [ ] Below-threshold dataset unchanged; entry details still row path

## Done
- [ ] All measured criteria green + PR merged
- [ ] Memory updated (actual byte ratio + any chip-semantics surprises) + **STOP**
      (part 5 = #63 next)

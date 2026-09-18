# Kickoff — Part 5: OPFS pin + TanStack Query persister (issue #63)

Part 5 of 5 implementing #58 — the final increment. Goal: repeat opens of an
unchanged dataset fetch **zero geometry bytes**, and lightweight app state
opens instantly across sessions.

## Read first
1. `docs/memory/MEMORY.md`, then `geometry-tile-breakdown.md` (you are #63)
2. Issue **#63** — full design + verification list
3. Skim issue #58's Phase 2 section (layered-cache rationale)

**Amend before handing off:** confirm part 4 shipped — where the protocol is
registered, how source selection resolves `meta` (so the OPFS source plugs in
at the same seam), and which queries exist whose keys identify "light"
namespaces (for the persister filter).

## Part 4 shipped (2026-09-17, PR #67) — confirm against this before starting

- **Protocol:** `app/src/components/ui/map.tsx` module scope — one
  `new PmtilesProtocol()` instance, `MapLibreGL.addProtocol("pmtiles",
  pmtilesProtocol.tile)` behind an SSR guard (no `getProtocol` exists in
  maplibre-gl; re-registration is an idempotent overwrite). `pmtiles@^4.5.0`
  is a runtime dep of `app`.
- **Source selection** (`app/src/lib/layer-source.ts`):
  `selectLayerSource(schemaRow, meta)` → `{kind:"vector", url:"pmtiles://"+
  meta.url}` iff the row is a fresh-archive candidate (storageId present ∧
  `mapTileArchiveBuiltVersion === (mapTileCacheVersion ?? 0)`) ∧ meta
  resolves; `{kind:"pending"}` while a fresh candidate's meta URL is in
  flight (withholds the row fetch); `{kind:"rows"}` otherwise. Hook surface:
  `useTileArchiveSources(datasets | undefined)` (one `tile_archives.metas`
  subscription for N ids), `useTileArchiveSource(schema, schemaId)` (single),
  `layerSourceKind`/`layerSourceUrl` (branch-free narrowing helpers),
  `splitSchemaIdsByDecision(schemaIds, decisions)` → `{rowSchemaIds,
  tileSources, sourcesPending}`. The threshold is never re-derived —
  archive presence implies it. The app-level fan-out query is
  `api.tile_archives.metas({schemaIds})` (input-order-aligned array; the
  react package's `useMapTileArchiveMeta` is NOT used — this app mounts no
  JsonCmsProvider).
- **`MapVectorTiles`** (`map.tsx`): props `{url, sourceLayer = "geojson"
  (SOURCE_LAYER_NAME), fillPaint, linePaint, circlePaint, fillHoverPaint,
  onClick, onHover, interactive, visible, beforeId, onIdle}`. Source spec
  `{type:"vector", url, promoteId:"entryId"}` (enables feature-state hover);
  fill+line+circle layers over the single source layer. Source (re)add is
  keyed on `url` (the hot-swap seam); the layer-sync effect ALSO keys on
  `url` so styling re-applies after a swap — don't drop that dep. `onIdle`
  fires once per source (re)add via `map.once("idle")`. `visible` toggles
  layout visibility (source + tile cache stay warm).
- **Consumers:** dataset page passes `source={decision}` into `EntriesMap`
  (row fetch gated on `kind === "rows"`; tile path never skeletons — its
  idle latch needs a mounted map); maps workspace + group page split via
  `splitSchemaIdsByDecision` and render `MapVectorTiles` per fresh dataset
  (`visible` = layer visibility). Route-level helpers `withEmptyRows`/
  `geospatialDatasetsFor`/`isLayersWorkspaceComplete`/`layersMapShouldMount`
  keep the pre-flagged page components at/below their baseline complexity.
- **On-demand entry reads:** `app/src/lib/geometry-rows.ts` —
  `fetchAllGeometryRows(schemaId)` (paginated loop over a lazy shared
  `ConvexClient`), `resolveGeometryRows(rows)` → `Map<rowId, Geometry>`,
  `resolveDatasetGeometryRows(schemaId)`. Exports await these only for
  datasets on the tile path (`resolveExportGeometries` in the dataset
  route, `mergedResolvedGeometries` in the group route); edit-panel prefill
  falls back to `api.geometries.getEntryGeometry` when rows aren't in hand.
- **Chip:** tile completeness = fresh archive ∧ map `idle` after source add,
  latched per mount (dataset page) or per-source arrived-set (maps
  workspace). NOTE: an external-basemap stall (CARTO flakes in this
  sandbox) legitimately holds the chip — `map.once("idle")` can't fire
  while the style hangs; pre-existing behavior, not tile-path-specific.
- **Measured (FY22 Action Plan, live):** fresh-archive map open = ~96 range
  requests / **1.49 MB = 3.2%** of the 46.55 MB row path (z0–3 fitted-view
  tiles are only ~97 KB; the rest is header+directory ranges). The installed
  archive itself is ~22.6 MB at maxZoom 14 — far above part 1's 10% fixture
  ratio (polygon datasets duplicate clipped geometry across the z0–14 tile
  stack; the fixture was line-heavy). Fine for part 5's 256 MB LRU, but
  calibrate expectations on ~22 MB per large dataset, not 5 MB.
- **Watch out:** the edit cycle flips tiles→rows until the rebuild lands
  (kickoff-mandated correctness fallback), so an edit on FY22 costs one full
  row pass (≈60 MB now) — same as the pre-tile status quo on edits; the win
  is opens/pan/zoom. The vite console bridge drops client lines under load —
  tap `window.Worker` messages in-page (before hydration) when hunting
  worker errors. Sandbox background processes get SIGTERM'd between turns:
  restart the json-cms backend (port 3216) BEFORE `app`'s `bun run dev`, and
  run the convex CLI from `app/` only.

## Task A — OPFS pin (tile archives)

- Layout: OPFS root → `tile-archives/{schemaId}/{version}.pmtiles`.
  Version-keyed paths make invalidation trivial and keep other tabs' still-
  valid old versions readable.
- Write: after part 3 installs an archive, fetch it once and write to OPFS via
  the **async OPFS API** (`getFileHandle().createWritable()` on the main
  thread). Sync access handles are worker-only and unnecessary — MapLibre's
  `addProtocol` resolves on the main thread. Request
  `navigator.storage.persist()` opportunistically.
- Read: implement the pmtiles `Source` interface (same as `FetchSource`) with
  an OPFS-backed implementation: serve byte ranges from the local copy when
  present, fall back to network (which backfills). Lookup = small in-memory
  meta→path map rebuilt from a directory scan at boot.
- Eviction: keep only the current version per schema; LRU budget across
  schemas (default **256 MB**, tunable constant) checked against
  `navigator.storage.estimate` + our own accounting. `deleteEntriesBySchema`/
  clear prunes that schema's OPFS entries on next meta observation.

## Task B — TanStack Query persister (light state ONLY)

`@tanstack/react-query` is already installed in the app.
- Wrap the app's QueryClient with **`PersistQueryClientProvider`** +
  `createAsyncStoragePersister` backed by `idb-keyval` (the docs' IndexedDB
  persister recipe: `persistClient`/`restoreClient`/`removeClient`).
- `buster` = tiny new query returning **max `mapTileCacheVersion` across
  schemas** (add it to part 2's API surface) — any geometry write bumps some
  version, invalidating persisted state exactly when data changed.
- `dehydrateOptions` filter to **light namespaces only** (schema rows, entries
  pages, meta/feature counts). Geometry payloads never enter the query cache
  (tile path bypasses it) — the filter makes that invariant explicit.
- `maxAge` 7 days; set the QueryClient `gcTime` ≥ `maxAge` (docs gotcha:
  gcTime < maxAge silently discards restored cache).

## Verification
- [ ] Second app open, no edits: zero archive bytes fetched (OPFS hit) —
      devtools network; map renders immediately
- [ ] Entry edit + rebuild → new version fetched once, old OPFS entry pruned
- [ ] LRU budget enforced (seed > budget with synthetic archives)
- [ ] Cold start: persisted light state renders tables instantly; a geometry
      write bumps the buster → persisted light state re-fetches once
- [ ] Multi-tab: two tabs on different versions converge on pruning without
      thrashing

## Non-goals
- No offline editing/sync (OPFS is a read cache); no service worker; no
  TanStack DB (optional future table-path increment, documented in #58).

## Done
- [ ] All verification criteria green + PR merged
- [ ] Memory updated (`geometry-tile-breakdown.md`: what shipped + measured
      repeat-open behavior)
- [ ] **STOP** — then close #58 (all five parts landed) and #51 (GeoJSON blob
      fallback no longer needed)

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

## #63 part-5 status (2026-09-18, PR #68 merged to `main`) — ALL FIVE PARTS DONE

#58 architecture complete: rows authoritative, tile archives as rendering
cache, HTTP cache + MapLibre cache + OPFS pin + persisted light state. #63,
#58, and #51 (fallback) closed.

- **OPFS pin (`app/src/lib/tile-archive-cache.ts`):** root-mounted
  `<TileArchiveCacheManager />` observes `tile_archives.metas` for all
  geospatial datasets → backfills each installed archive ONCE into
  `tile-archives/{schemaId}/{version}.pmtiles`, prunes superseded versions
  only after the replacement is local (a rebuild never blinds a live map),
  prunes immediately when the meta goes null, discards in-flight backfills
  for pruned schemas via a per-schema generation counter, enforces a 256 MB
  LRU (unit-tested), `navigator.storage.persist()` granted. Read seam: the
  pmtiles `Protocol` checks pre-added instances by `source.getKey()` before
  creating an implicit `FetchSource` — so the protocol instance moved to
  `app/src/lib/pmtiles-protocol.ts` and the pin calls `protocol.add(new
  PMTiles(OpfsBackfillSource))` keyed by the bare storage URL; the
  `pmtiles://` tile URL string is UNCHANGED from part 4 (zero consumer
  changes). `asyncThrottle`-free, storage access via async OPFS API.
- **Persister:** the app's data was ALL `convex/react` WebSocket hooks — the
  TanStack cache was EMPTY, so the persister had nothing to save. Connected
  the never-connected `@convex-dev/react-query` bridge (hashFn/queryFn
  defaults + `connect`) and migrated only the light queries on the two table
  surfaces (datasets browser: schemas/groups/collections; dataset page:
  schemas.get/entries.list) to `convexQuery()`. `PersistQueryClientProvider`
  + `createAsyncStoragePersister` + idb-keyval; buster = new trivial
  `schemas:maxTileCacheVersion` (server-side fold over the component list);
  light-namespace allowlist in `light-namespaces.ts` (default-deny — keeps
  `geometries:*` out of persisted state by construction); maxAge 7d, gcTime
  maxAge+1d; `onSuccess` fires an initial save. `convexQuery` keys are
  JSON-safe BY DESIGN (function NAME string, not the opaque ref — "Make
  query key serializable") — that is what makes persist/restore round-trip:
  `hydrate` rebuilds with the persisted hash, the integration's cache
  `"added"` listener re-subscribes (getFunctionName passes strings through),
  pushes land via setQueryData into the restored entry.
- **Persister gotchas that cost real debugging:** (1) a bare
  `convexQueryClient.connect()` throws "already subscribed" after an HMR
  module re-eval — and since the `context` memo is set after connect, EVERY
  SSR request 500s until fixed; connect must be idempotent (detect
  same-client via the `queryClient` getter). (2) v5's AsyncStorage contract
  calls `storage.setItem(key, value)` — a one-param handler silently stores
  the KEY as the payload, and restore then silently discards
  (`timestamp` undefined → removeClient). (3) The provider saves only on
  cache CHANGES — a quiet page never saves after boot → the `onSuccess`
  initial save is required. (4) The persist provider must not mount until
  the buster is defined — restoring against `undefined` buster discards the
  store on every cold start.
- **Verification technique (in-page):** vite serves HMR-touched modules under
  `?t=` cache-busters — `import('/src/lib/x.ts')` from a probe creates a
  DIFFERENT module instance than the app's; use the app's exact served URL.
  The IAB `evaluate` runs in an ISOLATED world (page `window.*` markers
  invisible; IndexedDB/OPFS shared; ~30s cap → two-phase probes that set a
  `document.documentElement.dataset.<key>` from an injected main-world
  `<script>`, then poll). Proved the pin by driving the app's own wired
  instance: `protocol.tiles.get(storageUrl).getHeader()/getZxy(...)` with a
  main-thread fetch counter — header + directory + a real z3 tile read with
  ZERO network fetches. MapLibre's own tile fetches run in its worker — a
  main-thread fetch patch cannot see them, and resource timing is empty in
  the IAB.
- **Live-verified:** edit on FY22 Action Plan (in-page ConvexHttpClient
  `entries.update` with a nudged coordinate — data-only edits don't bump;
  geometry edits do) → rebuild v5 installed (~4–5 min for 450 features z0–14)
  → client backfilled `5.pmtiles` (22,678,460 B) once, pruned `4.pmtiles`,
  re-wired the protocol; persisted payload = buster "4" + exactly
  schemas/groups/collections list keys; one restore discard observed when the
  payload was briefly malformed (the designed safety path). The worker
  errored once during "fetching" (transient; a directly spawned worker built
  fine). Multi-tab convergence pinned by prune-rule unit tests, not driven
  live. The map canvas stalled identically on a row-path CONTROL dataset —
  environmental, not part-5 (part 4 documented the same class).
- 30/30 app tests, `tsc --noEmit` clean, zero new lint errors (repo baseline
  untouched). PR #68 → `Closes #63`; #58 + #51 closed with a completion
  comment.

## #62 part-4 status (2026-09-17, PR #67 merged to `main`)

Tile rendering shipped: `pmtiles` Protocol registered once in `map.tsx`
(SSR-guarded; maplibre-gl has no `getProtocol` — overwrite is idempotent),
`MapVectorTiles` (vector source, `promoteId: "entryId"`, fill/line/circle
layers mirroring row-path styling, per-source `once("idle")` latch, visibility
toggles that keep tile caches warm, hot-swap = remove/re-add source keyed on
`url` — the layer-sync effect must also depend on `url` or layers vanish
after a swap), and `app/src/lib/layer-source.ts` (fresh-archive selection +
`tile_archives.metas` fan-out query + `splitSchemaIdsByDecision`). Consumers:
EntriesMap (`source` prop, three-state decision), LayersMap, GroupMap —
mixed tile+row rendering everywhere; collection extent maps stay bbox-only.
Exports/edit-prefill materialize rows on demand (`geometry-rows.ts`) so the
tile path keeps no standing row subscription. **Live-verified on FY22
(450 features)**: map open = ~96 range requests / **1.49 MB = 3.2%** of the
46.55 MB row path (target ≤5%); zero row fetches for rendering; click→entry
details works from tiles; SMART (13 KB) unchanged; layer toggles + the full
edit→rebuild→hot-swap cycle keep the map container AND canvas identity
(DOM-sentinel verified). 186 component + 14 app tests green, tsc clean, lint
finding SET identical to baseline (EntriesMap 18→13, Map/Group pages −1 —
extract into module helpers, never optional chaining).

- **Stale fallback is the row path (kickoff-mandated):** every edit flips
  tiles→rows until the rebuild converges — an FY22 edit costs one full row
  pass (~60 MB) — identical to the pre-tile status quo on edits; the win is
  opens/pan/zoom. Consequence fixed en route: the row path's "No geometry
  yet" gate must require a COMPLETED pass (`hasRenderedOnce || rowReady`),
  else the fresh fan-out flashes empty and remounts the map on the fallback.
- **Chip semantics:** tile completeness = fresh archive ∧ map `idle` after
  source add, latched per mount. An external-basemap stall (CARTO flakes in
  this sandbox) legitimately holds the chip forever — `idle` can't fire while
  the style hangs; pre-existing, reload recovers. Don't misread that as a
  tile-path bug.
- **Measured archive size surprise:** the real FY22 archive is ~22.6 MB
  (maxZoom 14), ~37–49% of payload text — far above part 1's 10% fixture
  ratio (polygons duplicate clipped geometry across the z0–14 stack; the
  fixture was line-heavy). Open cost stays tiny (viewport-bounded reads).
  Part 5's 256 MB LRU is fine; calibrate on ~22 MB per large dataset.
- **Verification gotchas (new):** the vite client-console bridge DROPS lines
  under load — wrap `window.Worker` in-page (before hydration) to tap the
  worker's real messages; `MapVectorTiles` mounts only post-decision, so
  React-fiber walks over `.maplibregl-map` give ground truth on which path
  renders (look for `MapVectorTiles` vs `RowPathFeatureLayers`/`MapClusterLayer`);
  MapLibre fetches tiles inside its worker — `performance.getEntriesByType`
  sees ZERO archive requests; measure bytes by replaying the pmtiles read
  sequence with a counting `Source` instead. Sandbox background processes
  get SIGTERM'd between turns (dev stack died 3× mid-verification — restart
  json-cms backend :3216 before app dev; convex CLI only from `app/`).
- **Next: part 5 (#63)** — kickoff `docs/kickoffs/part-5-opfs-and-persister.md`
  amended with the full part-4 surface. **STOP after part 4; #63 is the next
  session's chunk.**

## #61 part-3 status (2026-09-17, PR merged to `main`)

Client rebuild machinery shipped: `app/src/lib/tile-archive.worker.ts` +
`app/src/lib/tile-archive.ts`, the app-level wrapper `app/convex/
tile_archives.ts` (`install`), `@caden/geometry-archive` added to app deps.
186 component tests + 7 new app scheduler tests green; app tsc clean; lint
findings identical to the main baseline. **Live-verified on the dev
deployment** (throwaway dataset, deleted after): one build per edit burst
built at the FINAL version; a mid-build edit self-discarded (guard) and the
queued rebuild converged to fresh; deleteSchema removed the blob (404) +
meta.

- **Staleness amendment (the part-3 find):** part 2's `getMapTileArchiveMeta`
  returned `version: schemaDoc.mapTileCacheVersion` — the LIVE counter — so
  `meta.version` could never fall behind the row and staleness was
  unobservable (every doc comment described the built-at comparison). Added
  schema field `mapTileArchiveBuiltVersion` (patched by `setMapTileArchive`
  to `expectedVersion`; reset with the other cache fields by
  `deleteEntriesBySchema`); meta `version` now returns the built-at snapshot.
  Consumers compare `meta.version !== schema.mapTileCacheVersion`. Legacy
  archives missing the field read as no-archive (meta null) — self-healing
  (stale-on-view rebuilds only fire when version > 0, and a legacy row's
  version reads as 0, so nothing fires until the first edit bumps it).
- **Worker shape (verified — NO fallback needed):** standalone `ConvexClient`
  in the worker works (WebSocket fine); one build per inbound message;
  outbound `phase` states (fetching/building/uploading/installing) then ONE
  terminal message: `done` (builtVersion/bytes/maxZoom) | `stale-discarded`
  | `skipped` (reason: not-geospatial | below-threshold). Threshold applied
  on the exact assembled payload BEFORE building (small datasets skip
  upload/install — they attempt per edit-burst and skip; cheap ≤256 KB
  fetch, accepted). Builds serialize via a promise chain (the CPU-bound
  geojson-vt math never interleaves). Storage-backed rows fetch `geometryUrl`
  directly; all `JSON.parse` stays in the worker.
- **Manager shape:** `TileArchiveScheduler` — 5 s trailing debounce keyed by
  version (newer resets, equal/older keeps), single-flight per schema,
  at most ONE queued rebuild (queued when a trigger lands mid-build; it runs
  immediately after the in-flight settles — the worker re-reads the live
  version at start, so both outcomes converge to fresh), failed builds don't
  wedge (catch → in-flight cleared). `ensureMapTileArchive(schemaId)` skips
  the debounce (import UI completion calls it; geospatial-conversion/simplify
  workflows have no client hook — the root manager catches those the same
  way). `<TileArchiveManager />` is mounted in `__root.tsx` and watches ALL
  geospatial schemas from `api.schemas.list`: stale-on-view (meta.version
  behind mapTileCacheVersion) AND first-build (version > 0, no archive —
  covers legacy datasets and imports whose ensure-call raced).
- **Wrapper:** `app/convex/tile_archives.ts` `install` — auth + the component
  mutation + a same-transaction meta re-read to return
  `"installed" | "discarded"` (the guard's discard is silent otherwise; the
  worker's progress reporting needs the outcome). Not reachable through
  exposeApi; the app api path is `api.tile_archives.install` (snake case —
  the file name drives it).
- **App-side type/lint gotchas hit:** `oxc/no-optional-chaining` is an ERROR
  repo-wide (use `??`/explicit undefined checks; `??` is fine — the component
  uses it); worker-scope `postMessage`/`onmessage` → use `self.addEventListener`
  + an inline `unicorn/require-post-message-target-origin` disable (the
  rule's targetOrigin argument doesn't exist in worker scope); `Blob` part
  typing wants `Uint8Array<ArrayBuffer>` (copy once with `new Uint8Array(archive)`
  — fresh buffer, no cast); `vi.fn` needs explicit type params; don't run
  convex CLI from `packages/json-cms` mid-session (cwd gotcha — confirmed
  again).
- Part 4 kickoff (`docs/kickoffs/part-4-render-from-tiles.md`) amended with
  the part-3 surface + the built-version semantics + the "row path fallback
  when the archive is stale or missing" clarification.
- **Per the kickoff: STOP — part 4 (#62: rendering from tiles) is the next
  session's chunk.**

## #60 part-2 status (2026-09-17, merged to `main`)
Server plumbing shipped: schema fields (`mapTileCacheVersion`,
`mapTileArchiveStorageId/Bytes/MaxZoom`), unconditional version bumps on every
geometry-affecting write, `setMapTileArchive` with the `expectedVersion` guard,
`getMapTileArchiveMeta` + `useMapTileArchiveMeta`, `MAP_TILE_ARCHIVE_MIN_BYTES
= 262_144` (all in component `lib.ts`/`schema.ts`; `exposeApi` + app
`geometries.ts`; react `types.ts`/`hooks.ts`). App behaves exactly as before
(no consumer of the new fields yet). 185 convex-tests green, app tsc clean,
lint findings identical to the main baseline (repo has pre-existing ones).

- **Bump paths:** folded into `applyGeometryStatsDelta` (covers insert /
  replace / delete / clear — i.e. `createEntry`, `createEntriesBulk`,
  `insertEntry*Internal`, import chunks via `insertEntriesChunkInternal`,
  geospatial-conversion batches) — one patch, no extra read. Two paths patch
  the schema row directly and call `bumpMapTileCacheVersion` explicitly:
  `applySimplifiedGeometriesInternal` (one bump per batch write, not per row)
  and `deleteEntriesBySchema` (which also deletes the archive blob and resets
  all four fields). `deleteSchema` deletes the archive blob too (row dies, no
  reset needed). Data-only entry edits deliberately do NOT bump (tiles encode
  geometry + the spec scoped bumps to featureCount/boundingBox-maintaining
  paths); deleting a geometry-less entry also doesn't bump.
- **Spec amendment — `setMapTileArchive` is PUBLIC, not internal:** the
  generated ComponentApi only carries the component's PUBLIC functions, so an
  `internalMutation` would be invisible to the host app and part 3's
  app-level worker could never reach it. It is now a public component
  mutation, deliberately NOT re-exported through `exposeApi` (no browser
  path); part 3 installs via a thin app-level mutation wrapping
  `components.jsonCms.lib.setMapTileArchive` (ids as plain strings,
  component re-validates). Verified live through exactly that wrapper.
- **Guard details worth remembering:** absent version reads as 0 (legacy rows
  install at `expectedVersion: 0`); the install patches all four fields
  including `mapTileCacheVersion` so "archive present ⇒ version present"
  holds; `getMapTileArchiveMeta` returns null for missing schema, absent
  archive fields, or a dead blob URL (treat as row-path-only); stale install
  deletes only the INCOMING blob and leaves any installed archive alone;
  supersede deletes the old blob inside the mutation.
- **Live-verified round trip on the dev deployment** (throwaway dataset via
  `bunx convex run` from `app/`): install → meta with fetchable URL; real
  edit → version 2; stale install → self-discard (row untouched); re-install
  at current version → old blob 404s; `deleteSchema` → blob 404s + meta null.
  Temp wrapper file deleted after verification (the app-layer wrapper is
  part 3's to add properly).
- Part 3 kickoff amended with the wrapper pattern + corrected claim
  (`handleImportComplete` doesn't bump; chunk inserts do).

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

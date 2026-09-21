# Map Performance Audit — 2026-09-16

Audit of Convex function/query performance, triggered by the complaint that
"maps take a really long time to load the points." Recommendations are tracked
as GitHub issues **#48–#55** with the `performance` label. Companion summaries
live in [`docs/memory/`](./memory/MEMORY.md) (`map-performance-audit-2026-09`,
`geometry-transport-research`, `geolibre-research`).

## Method

- Static review of the `@caden/json-cms` component (`packages/json-cms/src/component/`)
  and app query paths, following the `get-convex/agent-skills` performance-audit
  methodology (installed into `.agents/skills/convex-*`). The live `insights`
  MCP tool is cloud-only and unavailable for a local deployment, so the audit
  fell back to the skills' code-review pass, backed by real measurements.
- Measurements ran against the running local dev deployment via
  `bunx convex run` from `app/` (targets the `local-` deployment), calling the
  app's exposed API (e.g. `geometries:list`, `entries:list`, `schemas:list`).

## Measurements (SS4A data, live dev deployment)

| Dataset                            | Features | Geometry payload                      | `listGeometries` pages (1 page = 1 round trip) |
| ---------------------------------- | -------- | ------------------------------------- | ---------------------------------------------- |
| SS4A FY22 Action Plan Grant Awards | 450      | 46.55 MB (avg 106 KB/row, max 878 KB) | **57**                                         |
| SS4A FY23 IG Awards                | 48       | 5.16 MB                               | 7                                              |
| SMART (points)                     | 134      | **0.013 MB**                          | **17**                                         |
| SS4A FY22 IG Awards                | 37       | 4.20 MB                               | —                                              |
| …(6dp twin, byte-identical)        | 37       | 4.20 MB                               | —                                              |

Popup-properties payload (entries, incl. CLI startup): FY22 Action Plan 0.27 MB
/ 450 rows; SMART 0.10 MB / 134 rows.

**Negative finding:** 6dp simplification is _not_ a performance lever for this
data — the (6dp) dataset and its full-precision twin are byte-identical; the
SS4A source is already ≤6 decimal places. The 46 MB is inherent vertex density;
only round-trip count and transport can improve it.

## Root causes

1. **Fixed 8-row page cap** — `MAX_GEOMETRY_PAGE_ROWS = 8`
   (`packages/json-cms/src/component/lib.ts`), sized for the ~900 KB worst-case
   row to stay under Convex's ~16 MiB per-execution read budget. Real rows
   average ~106 KB (points ~100 bytes), so pages use a fraction of the budget.
2. **Strictly serial page fetching** — `useAllPaginated`
   (`packages/json-cms/src/react/lib/all-paginated.ts`) requests 200 rows but
   receives 8; each page is a `loadMore` round trip gated through a React
   effect cycle (sync message → state → render → effect → next request).
   57 pages before the FY22 map can complete its first pass.
3. **Main-thread re-parsing** — `useResolvedGeometries`
   (`packages/json-cms/src/react/lib/geometry-resolve.ts`) `JSON.parse`s every
   accumulated row whenever the rows array changes — i.e. on every page arrival
   — so a 57-page pass parses ~1.3 GB cumulatively on the main thread.
4. **Collection extent map loads every geometry** to draw dashed bbox
   rectangles that `schemas.boundingBox` already denormalizes
   (`app/src/routes/collections/$collectionId/index.tsx` +
   `app/src/components/datasets-map.tsx`).
5. **Map workspace loads geometries for hidden layers too** (deliberate
   instant-toggle tradeoff) and **all entries for popups** up front
   (`app/src/routes/maps/$mapId.tsx`).
6. **`listSchemas` ships full `schema`/`uiSchema` objects** (up to 100 KB each)
   to every list page.
7. Third-party CDN dependencies on the map's critical path (maplibre worker
   from unpkg, basemap style from cartocdn — `app/src/components/ui/map.tsx`).

## Issues filed (2026-09-16)

| #                                                                     | Priority | Summary                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#48](https://github.com/whoiscadenyoung/json-data-manager/issues/48) | P0       | Byte-budgeted geometry pagination (57 → ~5 pages; SMART 17 → 1)                                                                                                                                                                                                                                                                     |
| [#49](https://github.com/whoiscadenyoung/json-data-manager/issues/49) | P0       | Collection extent map from stored `boundingBox` — zero geometry loads                                                                                                                                                                                                                                                               |
| [#50](https://github.com/whoiscadenyoung/json-data-manager/issues/50) | P1       | Visible map layers first; hidden layers prefetch in background                                                                                                                                                                                                                                                                      |
| [#51](https://github.com/whoiscadenyoung/json-data-manager/issues/51) | P1       | Per-dataset FeatureCollection blobs fetched + parsed by MapLibre off-thread; **design reviewed**: writes only invalidate (monotonic `mapFeatureCollectionVersion`), rebuild is a lazy debounced internal action, imports rebuild once at `handleImportComplete`, blob path only above a size threshold. **Implementation deferred** |
| [#52](https://github.com/whoiscadenyoung/json-data-manager/issues/52) | P2       | Popup entry properties fetched on click, not up front                                                                                                                                                                                                                                                                               |
| [#53](https://github.com/whoiscadenyoung/json-data-manager/issues/53) | P2       | Lightweight `listSchemaSummaries` projection for list pages                                                                                                                                                                                                                                                                         |
| [#55](https://github.com/whoiscadenyoung/json-data-manager/issues/55) | P3       | Entries-table server pagination + CDN worker/basemap self-hosting + small N+1 hygiene                                                                                                                                                                                                                                               |

Recommended order: #48 + #49 first (quick wins), #51's blob path designed and
waiting for when datasets outgrow the row path.

## Research: how peer projects load and capture geometry changes

Cloned and reviewed three reference projects (findings also in
`docs/memory/geometry-transport-research.md` and `geolibre-research.md`):

**Placemark** (github.com/placemark/placemark, **MIT**) — local-first GIS editor:

- Change capture = patch-based inverse "Moments"
  (`app/lib/persistence/moment.ts`): a Moment holds `{putFeatures: <full old
values>, deleteFeatures: <ids>}`; one `apply(moment)` computes its own
  reverse as a side effect, so undo and redo are the same code path
  (`app/lib/persistence/memory.ts`). History capped at 100; drags coalesce via
  pause/resume; `quiet` flag skips history. Maps cleanly onto our per-entry +
  `geometries` table model if we ever add undo.
- Render sync (`app/lib/pmap/index.ts`): split MapLibre sources (base features
  / ephemeral selection / vertex handles), properties stripped to what
  symbolization needs, and `mSetData` skips no-op updates (shallow compare +
  WeakMap per source). Cheap to adopt in our map UI regardless of #51.
- Parsing/validation in a Comlink worker (`app/lib/worker/`); MapLibre worker
  bundled locally (`?worker&url`) — validates #54.

**GeoLens** (github.com/geolens-io/geolens, **Apache-2.0**) — FastAPI + PostGIS,
read-only platform (no feature editing):

- Default dataset path = server vector tiles via PostGIS `ST_AsMVT`
  (`backend/app/processing/tiles/service.py`): per-zoom simplification below
  z10, no attribute columns below z10, 50k-feature cap per tile, server-side
  point clustering.
- Cache busting = **monotonic `tile_cache_version` integer bumped atomically
  on data refresh**, threaded into tile URLs (`_v=`) so client/CDN caches bust
  on any edit; unversioned requests fall back to 60s-TTL bounded staleness.
  This validates #51's `mapFeatureCollectionVersion` design almost exactly.
- GeoJSON sources reserved for small data (≤ 5,000 features); everything else
  is tiles. Guidance for #51's threshold.

**GeoLibre** (github.com/opengeos/GeoLibre, **MIT**) — local-first GIS workspace
(MapLibre + DuckDB-WASM Spatial + deck.gl, in-browser WASM geoprocessing):

- **Snapshot undo with a hard size budget** (`packages/core/src/history.ts`):
  snapshots trimmed oldest-first against a 500k feature-count proxy; unchanged
  layers dedup via object reference; inline `data:` URLs charged as
  feature-equivalents (200 B each) to avoid unbounded growth (their issue
  #341); 400 ms coalescing window folds drags into one undo entry.
- DuckDB-WASM Spatial as local SQL data engine (`ST_Read` over WASM-converted
  temp files), query layers rendered through a shared deck.gl overlay —
  candidate for future in-browser filtering/aggregation.
- deck.gl overlay for GPU-rendered massive layers; RFC 7946 six-value (Z)
  bbox guard (`horizontalBbox`) if we ever ingest 3D/GPX sources.

**Net assessment:** #51's invalidate + lazy-rebuild + version-field design is
production-validated by both GeoLens (tile_cache_version) and the general
pattern in Placemark. The `geometries` table is structurally Placemark's
per-feature-row model. Long-term destination for datasets far beyond 46 MB:
import-time pre-tiling (e.g. PMTiles), borrowing GeoLens's per-zoom
simplification and attribute-projection concepts at blob-generation time —
Convex has no PostGIS, so this would be generated in the import action.

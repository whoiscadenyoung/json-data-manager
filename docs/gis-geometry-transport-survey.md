# GIS Geometry Transport & Client Caching Survey

Research companion to issue **#58** (per-dataset vector-tile rendering cache)
and its implementation breakdown **#59–#63**. Compiled 2026-09-17; conclusions
validated against our own measurements in the
[map performance audit](./map-performance-audit-2026-09-16.md). The one-line
summary: **no major web GIS ships vertex-heavy geometry to maps as JSON text
rows — everything serves quantized binary tiles or cloud-optimized archives
read over HTTP range requests, cached in layers, and invalidated by version.**

## Platforms surveyed

### Commercial platforms

**ArcGIS** (feature services / ArcGIS Online) — the reference for
quantized-binary feature transport. The Query API serves features as
**PBF (protobuf)** — not JSON — with `quantizationParameters`: geometry is
projected onto a virtual integer grid (e.g. screen pixels), coordinates return
as integers relative to a fixed origin, and *consecutive coordinates that snap
to the same grid cell are removed*. `mode: view` quantizes for display;
`mode: edit` returns full resolution for editing. Further levers:
`maxAllowableOffset`, `geometryPrecision`, `returnGeometry=false`, and
`resultOffset`/`resultRecordCount` pagination with `exceededTransferLimit`.
Static/large layers ship instead as cached vector-tile layers.
[query-feature-service-layer](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/)

**CARTO** — two serving modes: **dynamic tiling** (SQL pushed to the data
warehouse, MVT generated per request, rendered client-side progressively as
you pan) and **pre-generated tilesets** for very large tables. Caching is a
CDN layer with `Cache-Control` (tiles cached ~indefinitely until the table is
modified), invalidated by **embedding a version in the query** — the same
version-bump principle #58/#60 adopt.
[performance considerations](https://docs.carto.com/carto-user-manual/maps/performance-considerations.md) ·
[cache guide](https://docs.carto.com/carto-for-developers/guides/managing-cache-in-your-carto-applications.md)

**Felt** — vector tiles end to end. Maintains **tippecanoe** (the standard
C++ GeoJSON→tileset builder) and **vt-chopper** ("slice GeoJSON into vector
tiles on the fly **in the browser**") — the same client-side generation pattern
our #61 worker uses. [github.com/felt](https://github.com/felt)

**Atlas** (atlas.co) — closed-source, "AI-native" collaborative GIS; supports
Shapefile/GeoJSON/KML/GPKG uploads and live PostgreSQL connections. Publishes
no public architecture documentation (no disclosed tiling/storage/caching
details), so it's a product-level reference only: the pattern it shares with
Felt is WebGL rendering and warehouse-backed sources.
[docs](https://atlas.co/docs)

**Mapbox** — the origin of the vector-tile + GL-ecosystem approach (MapLibre
is its open-source fork): vector-tile tilesets served from storage, with
MBTiles archives used for offline/mobile caching. (Their docs sites block
automated fetching; details here are background knowledge and uncontroversial.)

**kepler.gl / deck.gl / loaders.gl** — even pure-client-side analysis tools
left JSON text: loaders.gl treats **Apache Arrow** as a first-class input, and
kepler's overlays render WebGL-native. kepler keeps everything in browser
memory (analysis tool, not a hosted platform).

**Overture Maps Foundation** — the canonical cloud-native *distribution*
pattern: data published as **GeoParquet on S3**, queried directly over HTTP by
DuckDB (`httpfs` + `spatial`), with a download tool that "transfers only the
data inside your bounding box" by reading columnar files remotely — plus
published **PMTiles** artifacts for direct map rendering. Cloud-optimized
formats for both analysis (GeoParquet) and rendering (PMTiles).
[getting-data](https://docs.overturemaps.org/getting-data/)

### Open-source platforms & libraries

**Protomaps / PMTiles** — single-file tile-pyramid archives served over HTTP
**range requests** from plain static storage (no tile server): "at most two
cacheable intermediate requests" before tile fetches, 70%+ internal tile
dedup, first-class MapLibre client via `addProtocol`. The container our #59
writer targets. [docs.protomaps.com](https://docs.protomaps.com/pmtiles/)

**FlatGeobuf** — binary feature format with **range-request random access**
and a packed Hilbert R-tree spatial index; designed for CDN serving with
spatial-filtered partial reads. Benchmark vs GeoJSON: full read 0.46 vs 15,
spatial-filter read 0.71 vs 705, file size 0.77 vs 1.2. Read-optimized, no
random writes by design. [flatgeobuf.org](https://flatgeobuf.org/)

**Martin** (maplibre/martin) — Rust tile server "optimized for speed and heavy
traffic": serves PostGIS tables/functions as MVT, plus file sources
MBTiles/PMTiles/COG/**GeoParquet via DuckDB**, with style/sprite/font serving
and `martin-cp` for bulk archive generation. Represents the
run-a-tile-server option we deliberately avoid (no persistent server in our
Convex architecture). [maplibre.org/martin](https://maplibre.org/martin/)

**GeoServer + GeoWebCache** — the classic open-source stack: WFS serves
GeoJSON (and a **FlatGeobuf output format**) for full-fidelity feature access,
while the **Vector Tiles extension** serves pre-generalized MVT and
GeoWebCache caches tile layers to disk/S3/Azure/GCS/MBTiles blob stores with
seeding and quotas. Large vector data = vector tiles through the cache;
WFS/GeoJSON = detail/feature access. Same split as our row path vs tile path.
[geowebcache docs](https://docs.geoserver.org/latest/en/user/geowebcache/index.html)

**uMap** — the small-data contrast case: Django + Leaflet, map data **stored
as GeoJSON files on the server**, geo computation client-side, no tiling. Fine
for simple OSM-overlay maps; doesn't scale to vertex-dense datasets — the
failure mode our FY22 dataset hit. [dev overview](https://docs.umap-project.org/en/stable/dev/overview/)

### Prior internal research (in `docs/memory/`)

- **GeoLens** (Apache-2.0) — PostGIS `ST_AsMVT` server tiles with per-zoom
  simplification schedule and attribute columns dropped below z10; cache
  busting via a monotonic `tile_cache_version` threaded into tile URLs. Validates #58's version-bump design. (`geometry-transport-research`)
- **Placemark** (MIT) — per-feature rows + inverse-patch undo, worker-thread
  parsing via Comlink, split MapLibre sources so selection changes never churn
  the base source. Validates keeping rows authoritative + id-level hot-swaps. (`geometry-transport-research`)
- **GeoLibre** — DuckDB-WASM Spatial as a local engine for 500k-feature
  proxies; the "query locally" end of the spectrum. (`geolibre-research`)

## Common approaches (the patterns)

1. **Never transport vertex-heavy geometry as JSON text.** Every platform at
   scale moves to binary: PBF (ArcGIS), MVT (CARTO/GeoLens/Felt/Mapbox),
   FlatGeobuf/GeoParquet (Protomaps/Overture), Arrow (deck.gl family).
   JSON remains for small data and detail views only.
2. **Quantize to integer grids.** MVT encodes coordinates at extent 4096 with
   zigzag varints; ArcGIS quantizes to pixel grids and drops consecutive
   same-cell coordinates. Integer coords are 4–8 bytes/vertex vs ~23 bytes of
   decimal JSON text, and the snap-to-grid dedup reduces vertex *count*, not
   just encoding.
3. **Per-zoom tiling bounds bytes to the viewport.** Tiles are generated per
   zoom with a simplification schedule (tippecanoe defaults; GeoLens drops
   attributes below z10; ArcGIS uses `maxAllowableOffset`). The client fetches
   only visible tiles — first open cost scales with the *view*, not the
   dataset.
4. **Cloud-optimized single files over range requests.** PMTiles (tiles) and
   FlatGeobuf/GeoParquet (features) let static storage serve random-access
   reads with no server. This requires host range-request support — our
   storage layer provides it (`Cache-Control: private, max-age=30d`,
   `Accept-Ranges: bytes`, single-range 206; verified in the OSS backend
   source; cloud parity still to verify — see #58 risks).
5. **Version-based invalidation, everywhere.** CARTO embeds a version in the
   query; GeoLens bumps `tile_cache_version`; Overture pins release paths.
   #60's `mapTileCacheVersion` + new-storage-id-per-rebuild is the same idea,
   with immutable per-version blobs making HTTP cache entries non-colliding.
6. **Layered caches: CDN → HTTP cache → client.** Every platform's second
   access costs ~nothing. Client-side pinning exists where apps need
   guaranteed offline/instant access (Mapbox offline = MBTiles archives;
   our #63 = OPFS pin keyed by version).
7. **Attributes on demand.** Tiles carry id (+ minimal props); full attributes
   load per-feature on interaction (#52 popups) — GeoLens's sub-z10 attribute
   dropping is the same principle at the tile level.
8. **Full fidelity reserved for edit/detail paths.** ArcGIS's quantization
   `mode: edit` vs `mode: view` is exactly our split: rows authoritative for
   entry details, tiles for the canvas.
9. **Small data keeps simple paths.** GeoLens switches to GeoJSON below 5,000
   features; uMap never tiles at all. Our `MAP_TILE_ARCHIVE_MIN_BYTES` (256 KB)
   threshold implements the same idea.
10. **Generate where the CPU is cheapest.** Servers tile on demand from
    PostGIS (Martin, GeoServer, CARTO) or pre-generate archives
    (`martin-cp`, tippecanoe, CARTO tilesets); Felt/our #61 generate
    client-side to avoid server CPU and fit storage-less backends. Our
    choice (client worker at import + lazy rebuild) matches Convex's no-Node
    constraint and keeps action CPU free.

## Format decision matrix

| Format | Best for | Over HTTP | Client support | Not for |
|---|---|---|---|---|
| **MVT + PMTiles** | Map rendering, any size | Range requests; CDN-friendly | MapLibre native decode in worker | Feature querying/analysis |
| **FlatGeobuf** | Random-access feature reads, spatial filtering | Range requests + R-tree | fgb bundles for MapLibre/OL/Leaflet | Random writes; tile-based rendering |
| **GeoParquet / GeoArrow** | Analytics, bulk distribution, columnar reads | Partial bbox reads (Overture pattern) | DuckDB-WASM, loaders.gl/Arrow | Low-latency interactive rendering |
| **GeoJSON** | Small datasets, detail views, editing payloads | Plain fetch | Everything | Anything vertex-heavy |
| **TopoJSON** | Adjacent shared boundaries (arcs dedup) | Plain fetch | Modest | Point/line data; editing |

## How our plan maps to the patterns

| Our design | Pattern | Deliberate deviation |
|---|---|---|
| #59 PMTiles v3 writer, gzip, extent 4096, maxZoom 14 | 1–3 | — |
| #60 version field + new blob per rebuild | 5 | Bumps are unconditional, not threshold-gated (simpler invariant) |
| #61 client-side generation in a web worker | 3, 10 | No tile server / no PostGIS — Convex has neither; generation moves to import time (Felt's vt-chopper pattern) |
| #62 `pmtiles://` sources, id-only hit-testing, row-path fallback | 3, 7, 8, 9 | Chips keyed on version-currency ∧ map-idle instead of Exhausted (tile path has no Exhausted) |
| #63 OPFS pin + Query persister (light state) | 6 | No service worker; OPFS instead of Mapbox-style offline MBTiles |

Gaps we haven't addressed (all documented in #58's risks): cloud-deployment
range-request parity; geojson-vt simplification quality vs tippecanoe; a
future FlatGeobuf/GeoParquet layer if feature-level server-less queries
(independent of rendering) ever matter.

## Sources

All links inline above. Platform research was done via public docs (2026-09-16/17);
internal platform details for closed-source products (Felt, Atlas) are limited
to what they publish. Implementation decisions live in #59–#63; raw research
notes in `docs/memory/geometry-tile-archive-research.md` and
`docs/memory/geometry-transport-research.md`.

---
name: geometry-tile-archive-research
description: 2026-09-17 research behind issue #58 — per-dataset MVT/PMTiles
  rendering cache; major-GIS survey; Convex storage range+cache facts; PMTiles JS
  writer caveat
metadata:
  type: reference
---

Research done 2026-09-17 (main thread — subagent spawning still unavailable) for
issue #58 (`perf(geometry): render maps from per-dataset vector-tile archives +
layered client caching`), which supersedes #51's GeoJSON blob as the *rendering
cache format* while keeping #51's version/invalidate/rebuild/threshold design
verbatim. Extends [[geometry-transport-research]] and [[map-performance-audit-2026-09]].

**Survey (all links in issue #58):** ArcGIS serves PBF with integer-grid
`quantizationParameters` (consecutive same-pixel coords dropped; `mode: edit`
full-res vs `mode: view` quantized) + resultOffset pagination; CARTO = dynamic
MVT + pre-generated tilesets, `Cache-Control` CDN cache, invalidation by
version-in-query; Felt maintains tippecanoe + vt-chopper ("slice GeoJSON into
vector tiles on the fly in the browser"); Protomaps PMTiles = single-file tile
pyramid over HTTP range requests, MapLibre via `addProtocol`; FlatGeobuf =
range-request random access + Hilbert R-tree (benchmark: spatial-filter read
0.71 vs GeoJSON 705); GeoLens (prior research) = ST_AsMVT + per-zoom
simplification + `tile_cache_version` bump. Nobody ships vertex-heavy geometry
as JSON rows; everyone invalidates via version bump.

**Convex storage facts (read from OSS backend source `get-convex/convex-backend`,
crates/local_backend/src/storage.rs):** storage URLs serve
`Cache-Control: private, max-age=30d` (MAX_CACHE_AGE, storage.rs:58) and
`Accept-Ranges: bytes` with single-range 206 + Content-Range (multi-range →
416; S3-underlying limitation). Bearer URLs, revocable only by deleting the
file. Cloud deployment parity NOT verified — check with one curl Range probe
during #58 implementation. **Implication:** PMTiles-over-storage is feasible
(no tile server needed) and rebuilt archives get a NEW storage id → per-version
browser cache entries never collide.

**PMTiles JS caveat:** reference `pmtiles` npm package is READ-ONLY (checked js/src:
no writer exports). Writer is ours against the public-domain v3 spec (few hundred
lines); community writers exist to crib from (atniclimate/dynamic-drought-module
`scripts/lib/pmtiles-writer.mjs`, mapzimus pmtiles-writer.js). Fallback = flat
in-house container + own addProtocol handler — architecture unchanged.

**Tile-gen stack (browser-safe):** geojson-vt + vt-pbf (MapLibre's own worker uses
geojson-vt). Tiles carry id + minimal props only (popups stay on-demand, #52,
GeoLens-style attribute dropping below z10). Full-res geometry stays on the row
path (getEntryGeometry / entry details).

**Client-cache layering for #58:** (1) HTTP cache — already 30d private, free;
(2) MapLibre internal tile cache; (3) optional OPFS pin keyed by (schemaId,
version); (4) TanStack Query persister = whole-cache dehydrate + throttled
rewrites + buster (persistQueryClient docs) — right for schema rows/entries
pages, WRONG for 46MB-scale payloads; (5) TanStack DB — incremental live queries
via d2ts, on-demand/progressive sync modes, no native OPFS — fits entries path,
tiles bypass it. TanStack DB sync modes: eager <10k rows, on-demand, progressive.

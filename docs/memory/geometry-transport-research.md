---
name: geometry-transport-research
description: 2026-09-16 research into Placemark (MIT) + GeoLens (Apache-2.0)
  geometry loading/change-capture patterns validating the #51 blob design; concrete file refs
metadata:
  node_type: memory
  type: reference
  originSessionId: sess_6658d494-1077-4e60-a900-a0d0d69a74b2
---

Research done 2026-09-16 (main agent — subagent spawning unavailable on this plan: "no reasoning level selected" error on any Agent launch) for [[map-performance-audit-2026-09]] issue #51. Cloned shallow to /tmp/placemark-research + /tmp/geolens-research.

**Placemark (MIT, github.com/placemark/placemark)** — local-first GIS editor, MapLibre + jotai, no tiles:
- Change capture = patch-based inverse **Moments** (`app/lib/persistence/moment.ts`): a Moment = `{putFeatures: <full old values>, deleteFeatures: <ids>, ...}`; one `apply(moment)` computes its own reverse as a side effect (memory.ts `useTransact`/`apply`), so undo and redo are the same apply call pushing the reverse to the opposite stack. HISTORY_LIMIT=100; drag ops coalesce via startSnapshot/endSnapshot pause; `quiet` flag skips history.
- Storage model = per-feature rows (`featureMap: Map<id, IWrappedFeature>`) with fractional-indexing `at` order keys (`generateKeyBetween`); pluggable `IPersistence` (public repo ships memory impl only).
- Render sync (`app/lib/pmap/index.ts` `setData`): split MapLibre sources — base features / ephemeral selection / synthetic vertex handles / lasso — so selection changes never churn the base source; `stripFeature` minimizes properties per symbolization ("barebones IR"); `mSetData` skips no-op updates via `shallowArrayEqual` + WeakMap per source; selection diffs via `setFeatureState`.
- Parsing/validation off main thread via **Comlink worker** (`app/lib/worker/`) exposing @placemarkio/check-geojson `getIssues`, `fileToGeoJSON`, buffer, boolean ops.
- MapLibre worker **bundled** (`maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` in pmap/index.ts) — validates #54 hygiene item.

**GeoLens (Apache-2.0, github.com/geolens-io/geolens)** — FastAPI + PostGIS + React, read-only platform (no feature editing, as user said):
- Default dataset path = **server vector tiles**: PostGIS `ST_AsMVT` (`backend/app/processing/tiles/service.py`) with per-zoom simplification schedule below z10 (sub-pixel tolerance), **no attribute columns below z10** (824 KB→bounded tiles on wide tables), **50k feature cap per tile** for tail latency, server-side point clustering (100k input cap).
- **Cache busting = monotonic `tile_cache_version` integer bumped atomically on data refresh** (`bump_tile_cache_version_atomic` in ingest/tasks_postgis_refresh.py), threaded into tile URLs as `_v=` ("a reupload/geometry edit busts client/CDN caches", MVT-04 in frontend builder/map-sync.ts); unversioned requests fall back to 60s-TTL bounded staleness — validates #51's `mapFeatureCollectionVersion` design almost exactly.
- **GeoJSON only for small data**: 3D datasets with `feature_count <= 5000` and client-cluster layers (CLUSTER_GEOJSON_FEATURE_LIMIT=5000, builder/cluster-source.ts) use geojson sources; everything else is vector tiles.
- Frontend adds `type: 'vector'` sources with signed tile URLs; geojson sources only for drawing overlays.

**Implications for our stack**: #51's invalidate+lazy-rebuild + version-field design is production-validated by both projects. #48's byte-budget pagination is our interim row path. Long-term destination for big data = pre-tiled vectors (PMTiles generated at import time, e.g. via GDAL in the import action) — GeoLens's server tiles aren't directly portable to Convex (no PostGIS), but per-zoom simplification + attribute projection are concepts we could bake into import-time blob generation. Placemark's per-feature-row + inverse-patch history is the natural fit for our per-entry/geometry table model if we ever add undo; Moment-style patches map cleanly onto our existing mutations.

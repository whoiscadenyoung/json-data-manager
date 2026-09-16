---
name: geolibre-research
description: 2026-09-16 research into opengeos/GeoLibre (MIT) — size-budgeted snapshot undo, DuckDB-WASM local engine + deck.gl overlay; what's transferable to our stack
metadata:
  type: reference
---

Research done 2026-09-16 (cloned to /tmp/geolibre-research), third project in the [[geometry-transport-research]] series for [[map-performance-audit-2026-09]].

**What it is**: opengeos/GeoLibre — MIT (Qiusheng Wu), Tauri v2 + React + TypeScript monorepo. Local-first, cloud-native GIS workspace: MapLibre GL JS + **DuckDB-WASM Spatial** + deck.gl, 1,000+ geoprocessing tools running fully in-browser via WASM. Ships as web/desktop/mobile/Jupyter. It's a viewer/analyzer — no server-side dataset modification/change-capture (like GeoLens, unlike Placemark).

**Worthwhile findings**:

1. **Snapshot undo history with a hard size budget** (`packages/core/src/history.ts`) — the middle ground between "no history" and "unbounded memory": each edit pushes a snapshot holding the layer's full geojson, but a budget (500,000 feature-count proxy, 200 bytes/feature-equivalent) trims the OLDEST snapshots first when distinct features across snapshots exceed it. Clever details: unchanged layers keep the same object reference across snapshots and are counted once via a `seen` set (reference dedup); inline `data:` URLs are charged as feature-equivalents because re-symbolizing a raster writes a fresh multi-MB string per edit (their issue #341 was unbounded memory growth); a 400 ms coalescing window folds slider drags into one undo entry. Contrast with Placemark's patch-based inverse Moments (100 deep, no size accounting) — for SERVER-backed edits our per-entry table + inverse patches (Placemark style) stays the right model; GeoLibre's budget/dedup/coalesce trio is what to borrow if we ever do snapshot-style client undo.

2. **DuckDB-WASM Spatial as the local data engine** — datasets are WASM-converted to temp files and queried with SQL (`ST_Read(<quoted temp file>)`, `packages/processing/src/`), producing "query layers" rendered through a shared deck.gl overlay. SQL + spatial joins/aggregation in-browser with no upload — a candidate pattern for future in-browser dataset filtering/summaries in our app (server round-trip free), though Convex reactivity would sit on top.

3. **deck.gl shared overlay for GPU-rendered massive layers** (`packages/plugins/src/plugins/deckgl-viz/`, "render through the shared deck.gl overlay" in core/src/types.ts) — Scatterplot/Polygon/PointCloud layers handle feature counts where MapLibre per-feature circle layers choke. Relevant only if our datasets grow far beyond the current 46 MB; MapLibre's worker-thread GeoJSON source covers our near-term needs (#51).

4. **geojson-z helpers** (`packages/core/src/geojson-z.ts`) — RFC 7946 six-value bboxes (with elevation) will otherwise misparse as lon/lat pairs (#2358); `horizontalBbox` trims to 4 values. Marginal today, but a cheap correctness guard if we ever ingest GPX/3D sources — our `asBoundingBox` assumes exactly 4 numbers.

Not relevant: Tauri multi-platform packaging, plugin ecosystem, Cesium/3D-tiles bits.

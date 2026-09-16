---
name: map-performance-audit-2026-09
description: 2026-09-16 Convex perf audit — map load slow root causes + issues #48–#55; key measurements and the 8-row page cap finding
metadata:
  node_type: memory
  type: project
  originSessionId: sess_6658d494-1077-4e60-a900-a0d0d69a74b2
---

Convex performance audit done 2026-09-16 (user complaint: "maps take a really long time to load the points"). Recommendations tracked as GitHub issues #48–#55 (`performance` label). Measured against the live local dev deployment via `bunx convex run` (works from `app/`, targets the `local-` deployment; read-only via the app's exposed API like `geometries:list`).

Key findings (see [[gis-feature-initiative]] for the feature context):
- **Root cause #1**: `MAX_GEOMETRY_PAGE_ROWS = 8` in `packages/json-cms/src/component/lib.ts` (fixed row cap sized for the ~900 KB worst-case row). Real measurements: FY22 Action Plan 450 features = **46.55 MB** payload = **57 serial pages**; SMART 134 points = 13 KB = **17 pages**. `useAllPaginated` (react lib/all-paginated.ts) chains pages serially through a `loadMore`-in-effect loop, one React commit per page. Fix = byte-budgeted pagination (issue #48).
- **6dp simplification is NOT a lever**: measured the (6dp) twin vs full-precision twin — byte-identical (4.20 MB each); SS4A source is already ≤6dp. Payload is inherent vertex density. Don't re-suggest simplification for perf.
- **Collection extent map wastefully loads ALL geometries** just to draw dashed bbox rectangles that `schemas.boundingBox` already denormalizes (issue #49) — biggest cheap win.
- **Map workspace loads geometries for hidden layers too** (deliberate instant-toggle tradeoff) and **all entries for popups** (measured small: 0.27 MB/450 rows) (issues #50, #51 → popup issue renumbered; popup = #51... actually: #48 byte cap, #49 extent map, #50 visible-first, #51 FeatureCollection blobs, #52 popups on demand, #53 schema summaries, #54 (lost, superseded by #55) entries pagination + CDN worker/style hygiene).
- Map UI (app/src/components/ui/map.tsx) pulls maplibre worker from unpkg + basemap style from cartocdn at mount — third-party deps on the critical path (#54).
- `useResolvedGeometries` re-JSON.parses ALL accumulated rows on every page arrival (memo keyed on array identity) — worst case ~1.3 GB cumulative parse per FY22 full pass; the FeatureCollection-blob design (#51) also fixes this via MapLibre worker-thread parse.

**Issue #51 blob design (refined 2026-09-16 after user raised "wouldn't the blob be rewritten on every geometry change?")**: naive per-write reassembly is wrong — a single entry edit would re-read+re-write the full 46 MB blob, and imports write chunks continuously. Agreed shape: writes only **invalidate** (patch a monotonically increasing `mapFeatureCollectionVersion` on the schema row, piggybacking on paths that already patch featureCount/boundingBox); rebuild is **lazy + debounced** via an internal action (actions can't read db → pages an internal listGeometries query via `ctx.runQuery`, then one `ctx.storage.put`, deleting the superseded blob — same action+runQuery pattern as `insertChunkFromStorage`), triggered by stale-version-on-view and/or a scheduled sweep; **imports rebuild exactly once at the existing `handleImportComplete` hook**, never per chunk; deleteEntriesBySchema/clear **drops the blob entirely**; row-level reads (getEntryGeometry/listGeometries) stay authoritative for detail views — blob is a rendering cache, version bump flows through live reactivity and `source.setData` hot-swaps the map (matches the never-unmount-a-live-map philosophy). Also recommended: apply the blob path **only above a size threshold** (datasets over a few hundred KB of geometry) — SMART's 13 KB is cheaper via the row path; small datasets keep today's UX. Non-obvious Convex facts: `ctx.storage.get` is action-only while `getUrl` works in queries; actions lack `ctx.db` but can read via internal queries.

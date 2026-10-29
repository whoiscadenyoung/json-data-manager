# #187 server-side tile-archive builds — design pass (2026-10-29)

> **Status 2026-10-29:** phase 1 was built and measured, then dropped (slower than the browser worker, V8 runtime OOM at 64 MB). Kept as a record; see `published-map-load-options-2026-10-29.md`.

Umbrella #182. Handoff: `docs/map-performance-handoff-2026-10-29.md`.

## Why

Cold open of a fresh 20k-point dataset is 16.5 s; ~12 s is the browser worker fetching every geometry row over the websocket, ~4 s is the build. A server action reads the rows next to the database, so the 12 s should collapse and the 4 s stays. Target is under 10 s.

## Feasibility (from the code)

- **Builder is portable.** `@caden/geometry-archive` depends only on `fflate`, `geojson-vt`, `vt-pbf` (pure JS, no DOM/Worker APIs). `@caden/maps/geometry-features` (`resolveRow`, `feature`) uses `fetch` + `TextDecoder`, both in the Convex runtime. Both run in an action unchanged.
- **Row reads.** The action can call `components.jsonCms.*` queries directly (no browser auth hop). `listGeometries` already self-clamps to the ~16 MiB per-query read cap, so paging works the same as the worker's `forEachDatasetGeometryPage`. Rows with `geometryUrl` are fetched with `fetch`, bounded by `BoundedPool` as today.
- **Blob install.** Component storage is namespaced, so the host cannot `ctx.storage.store` it. The worker's flow works from an action too: get a component-issued upload URL, `fetch` POST the bytes, then `tile_archives.install` (claimUpload + `setMapTileArchive` with `expectedVersion`). The guard, provenance check and discard semantics are all reused. The host needs an internal (non-client) variant of `generateUploadUrl`/`install`, since the current ones call `auth(ctx)`.
- **Runtime choice.** Default V8 runtime actions have a 64 MiB memory cap; `"use node"` actions get 512 MiB. A 20k-point set is a few MB of geometry, but large polygon sets (and geojson-vt's tile index) can exceed 64 MiB. Recommend `"use node"` in its own file (no queries/mutations alongside, per `guidelines.md`). Needs a measurement on a 50k-feature and a big-polygon set before committing.
- **Time.** Actions get 10 min; the 4 s build is nowhere near.

## Open risks

1. **Memory ceiling** for polygon-heavy datasets: fall back to the client path (error → existing #184 backoff → rows) rather than failing the dataset.
2. **Action arg/return limits** are irrelevant (no big payloads cross the boundary; geometry stays inside the action).
3. **Query read budget:** every page query counts against its own transaction, not the action's, so 40 pages of 500 rows is fine.
4. **Auth:** server-triggered builds have no user. They need the internal install variant; the public trigger action (phase 1) keeps `auth(ctx, {type: "update"})`.

## Plan, in two phases

**Phase 1 — server executes, client still decides when (small, low risk).**

- New `app/convex/cms/tile_archive_build.ts` (`"use node"`): `build` public action `{schemaId}` → auth, then the worker's `runBuild` logic server-side; returns the same outcome (`installed | discarded | skipped`, plus `builtVersion`, `version` for the skip memo).
- Internal mutation variants for upload URL + install (no user auth; scope still checked).
- `tile-archive.ts`: `buildViaWorker` becomes `buildViaServer` (calls the action, sets `fetching/building/…` states coarsely: `scheduled → building → done`). Scheduler, backoff, skip memo, `noteInstalled` all unchanged. Worker is kept behind a fallback (action error → worker build once) for the memory-ceiling risk.
- Expected: cold open ≈ import time + ~4–5 s build.

**Phase 2 — server decides when.**

- Import completion schedules the action via `ctx.scheduler.runAfter`; edits are covered by a cron sweep (or a debounced scheduled run keyed by version) over stale geospatial schemas using `isTileArchiveStale`. Client manager becomes a fallback only. Needs a decision on cron cadence vs scheduling from host write wrappers (the component's own mutations cannot call host functions).

## Verification plan

Isolated backend per the handoff recipe, 20k points, compare to the 16.5 s baseline; then 50k file; then one polygon-heavy set for the memory check. Tests: convex-test for the internal install (stale `expectedVersion` discards, bad `uploadId` rejects); existing scheduler tests stay green.

## Decision needed

Phase 1 first, then measure, then phase 2? And `"use node"` by default, or start in the V8 runtime and only move if memory demands it?

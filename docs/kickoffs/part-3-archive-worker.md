# Kickoff — Part 3: archive worker + rebuild orchestration (issue #61)

Part 3 of 5 implementing #58. After this part, above-threshold datasets
maintain a fresh tile archive reactively — but nothing renders from it yet
(part 4).

## Read first
1. `docs/memory/MEMORY.md`, then `geometry-tile-breakdown.md` (you are #61;
   its per-part decisions section is your spec crib sheet)
2. `docs/memory/local-dev-verification.md` + `gis-feature-initiative.md`
   (dev stack: component backend ports 3216/3217, app via `bun run dev`,
   package dist rebuild rules)
3. Issue **#61** — full design; parts #59/#60 for the builder API and the
   server surface you call

**Amend before handing off:** confirm part 2 actually shipped
(`setMapTileArchive` shape, meta query/hook names, threshold constant) and
part 1's builder API from the package source + memory.

## Task

App-level module pair:
- `app/src/lib/tile-archive.worker.ts` — the worker
- `app/src/lib/tile-archive.ts` — manager hook (`useMapTileArchiveManager`) +
  `ensureMapTileArchive(schemaId)`

Worker (one build = one message round trip; postMessage progress states:
fetching/building/uploading/installing/done/stale-discarded):
1. Own a standalone `ConvexClient` (`convex/browser` in a web worker —
   WebSocket works in worker scope). **Risk + documented fallback:** if the
   client misbehaves in a worker, fetch pages on the main thread and post
   rows to the worker as transferable ArrayBuffers — build logic identical.
   Spike this early.
2. Page `api.geometries.list` until `status === "Exhausted"` (same completeness
   semantics as `useAllPaginated`; never `isLoading`). Storage-backed rows:
   fetch their `geometryUrl` payload directly.
3. Assemble FeatureCollection (`entryId` + geometry) → `buildGeometryArchive`
   (part 1 package).
4. Storage upload URL flow (same as the import path) → POST archive →
   `setMapTileArchive` with **`expectedVersion` = version captured BEFORE
   generation** (part 2's guard makes mid-build invalidation self-discarding).

Manager:
- Single-flight per schema (module-level `Map<schemaId, Promise>`), trailing
  debounce ≈5 s → bursts rebuild once.
- **Triggers:** (a) stale-on-view — authoritative, self-healing: any consumer
  of `useMapTileArchiveMeta` seeing `meta.version` behind the schema's current
  `mapTileCacheVersion` schedules a rebuild; (b) import UI success →
  `ensureMapTileArchive(schemaId)` for immediacy.
- **`handleImportComplete` (`component/lib.ts:2239`) is a SERVER-side workflow
  callback — there is NO client completion hook.** It bumps the version
  (part 2); stale-on-view + ensure-call give "imports rebuild exactly once,
  never per chunk". No scheduled sweep needed (documented).
- Below-threshold datasets: manager no-ops.

## Verification
- Unit-test manager debounce/single-flight with a fake worker (burst → one
  build; overlapping triggers → one build).
- Dev integration: import an above-threshold fixture → blob exists, fields
  set; N rapid entry edits → exactly one rebuild; force a version bump during
  an artificially slowed build → stale build self-discards, fresh one runs.

## Done
- [ ] Tests + dev verification above all green
- [ ] PR merged + memory updated (note which fallback — worker or
      main-thread-fetch — was actually needed) + **STOP** (part 4 = #62 next)

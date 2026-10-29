# Packed geometry snapshot — design (2026-10-29)

> **Status 2026-10-29:** shelved, not implemented. The snapshot-plus-change-feed variant is option C in `published-map-load-options-2026-10-29.md`.

Umbrella #182. Follows `docs/map-server-archive-build-design-2026-10-29.md` (server-side build: dropped) and the page-query profile in `docs/memory/map-performance-audit-2026-10.md`.

## Problem

After an import, the first map open waits ~16 s (20k points): ~12 s reading geometry rows, ~4 s building tiles. Profiling showed the read cost is the database reading each document (~1 ms/doc locally, linear, and parallel queries do not add throughput). Paging, parallelism and moving the build server-side do not remove it. Only reading fewer documents does.

## Idea

At import time the server already holds every resolved geometry plus the entry id it just inserted. Write those out as a few packed blobs (one "part" per workflow chunk group, ~4000 features) alongside the rows. The tile build then downloads a handful of files instead of reading 20k documents.

Expected cold open (20k points): ~1 s download + ~4 s build, about 5 s, against 16 s today. Import gets a little slower (one blob store and one record per group).

## Data model

New component table `geometrySnapshotParts`: `{ schemaId, importId, chunkIndex, storageId, features, bytes }`, indexed `by_schema`. Plus on `schemas`: `geometrySnapshotVersion?: number` (the `mapTileCacheVersion` the parts describe) and `geometrySnapshotFeatures?: number`.

Part format: JSON `[[entryId, geometryJson], …]` where `geometryJson` is the exact string stored in the `geometries` row (inline) so the worker's `resolveRow` path is reused unchanged. Rows whose geometry lives in file storage (large polygons) are not packed: the snapshot is skipped for the dataset (see limits).

## Write path (import)

1. `insertEntriesChunkInternal` returns the inserted entry ids (it already gets them from `insertEntryBatch`).
2. `insertChunk` (inside `insertChunkGroup`) zips ids with the resolved geometries, stores one part blob with `ctx.storage.store`, then records it. Keyed by `(importId, chunkIndex)`, so a replayed step replaces or skips rather than duplicating, the same journal idea as `completedChunks`.
3. `completeImport` (already the completion gate) checks that parts cover every geometry row (`sum(features) === featureCount`), then stamps `geometrySnapshotVersion = mapTileCacheVersion` in the same transaction. If anything is missing, no stamp: the dataset simply uses the row path.

## Validity

A snapshot is valid iff `geometrySnapshotVersion === mapTileCacheVersion`. Any geometry-affecting write bumps the version (existing behavior), so edits, deletes, clears, simplification and geospatial conversion all invalidate it automatically. No per-edit maintenance.

On invalidation or schema delete/clear, a mutation deletes the parts and their blobs (same cleanup shape as `setMapTileArchive` superseding an archive).

## Read path

- New exposed query `getGeometrySnapshot({schemaId})` → `null` or `{ version, parts: [{ url, features }] }`, `null` unless valid. Behind `exposeApi`/`auth` like `getMapTileArchiveMeta` (blob ids stay server-side; only URLs leave).
- In the worker's `runBuild`: ask for the snapshot first. If present, fetch parts through the existing `BoundedPool`, parse into features, build and install with `expectedVersion = snapshot.version`. If absent or any part fails, fall back to the current row read. The install guard, backoff, skip memo and scheduler are untouched.

## By-product snapshots (phase B, optional)

After a row-path build, the worker already holds the features. It could upload them as a snapshot for that version so a later rebuild on another device skips the read. Edited datasets still pay one row read per edit burst. Not needed for the import headline case.

## Limits and risks

- **Large polygons:** skip the snapshot if any row is storage-backed or total payload exceeds a cap (suggest 64 MB). Fall back to rows.
- **Action memory (64 MB V8 runtime):** one part per ~500-row chunk (max 4 MB of source JSON) keeps each store call small, and `insertChunkGroup` processes chunks one at a time.
- **Storage cost:** roughly one extra copy of the geometry payload (~1.5 MB for 20k points). Deleted with the dataset or on invalidation.
- **Version race:** the stamp is written inside `completeImport`'s transaction against the same version it reads, so a concurrent edit makes the stamp stale rather than wrong.
- **Existing datasets:** no snapshot until re-imported or phase B; row path continues to work.

## Plan

1. Schema + `geometrySnapshotParts`; make `insertEntriesChunkInternal` return ids; write parts in `insertChunk`; stamp in `completeImport`; invalidation and cleanup.
2. `getGeometrySnapshot` query + `exposeApi` wiring (`_generated/component.ts` is hand-edited, see memory).
3. Worker snapshot-first path with fallback.
4. convex-test coverage: replayed chunk, missing part → no stamp, edit → invalid, cleanup. App/worker unit tests for the fallback.
5. Re-run the isolated-backend 20k cold open; compare against 16 s.

## Decisions for you

- v1 import-only (edits fall back to row reads), with by-product snapshots later?
- Size cap for packing (64 MB suggested)?

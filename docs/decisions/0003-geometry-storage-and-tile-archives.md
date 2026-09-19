# 3. Geometry storage as JSON text; rendering through per-dataset tile archives

- Status: accepted
- Date: 2026-09 (storage from the geospatial build-out; the tile path from
  the 2026-09-16 performance audit, issues #51/#58)

## Context

Real GIS rows carry heavy coordinate payloads, and Convex caps any single
array — including one nested in a document or argument — at 8192 elements,
and documents at ~1 MiB. A real-world dataset ring can exceed both. Reading
was also the problem: the audit measured one dataset's map load at 57 serial
pages / 46.55 MB of JSON geometry, and the GIS transport survey found that no
major web GIS ships vertex-heavy geometry to browsers as JSON text rows —
everything serves quantized binary tiles read over HTTP range requests.

## Decision

**Storage — GeoJSON as JSON text in the component's `geometries` table.**
Geometry is serialized to JSON text (no array-length ceiling) and stored
inline (`geometryJson`) when it fits comfortably under the per-document
limit, or as a file-storage blob (`geometryStorageId`) when it does not.
Exactly one is set. Entries hold only a pointer plus a denormalized type —
paging entries never drags coordinates along. (A legacy nested-array field
remains declared, unwritten, so pre-migration rows validate.)

**Summaries — denormalized onto the dataset, maintained incrementally.**
`entryCount`/`featureCount` are kept exact; `boundingBox` is a
non-shrinking envelope (deletes never shrink it — that would require
rescanning all geometries). Collection-level geospatial filtering reads a
denormalized `kind` on membership rows to avoid a per-dataset N+1.

**Rendering — two paths behind one decision point.** Small datasets render
GeoJSON from byte-budget pagination (~5 MB/page). Datasets above the archive
threshold render from a per-dataset PMTiles archive built by an in-browser
worker (`@caden/geometry-archive`), served over HTTP range requests from
storage, cached in a 256 MB OPFS LRU, and selected/rendered identically by
the map components. Correctness rests on version guards: every geometry
write bumps `mapTileCacheVersion`; an archive install carries the version it
was built from and self-discards if edits raced the build. An earlier design
(a single cached GeoJSON blob per dataset, #51) was superseded by this one.

## Consequences

- Map opens on archived datasets cost one metadata read + tile range
  requests; repeat opens hit OPFS and fetch zero archive bytes.
- The row path remains the universal fallback, so archives are an
  optimization, never a requirement.
- The bounding-box envelope can overestimate after deletions — acceptable
  for its uses (default viewport, list badges), not a source of truth.
- Build cost moves to the client worker; a failed or raced build is simply
  discarded and the dataset stays on the row path.

# Published map and dataset load — options (2026-10-29)

Umbrella #182. Follows `docs/map-performance-handoff-2026-10-29.md`. Nothing here is decided or implemented; this records what we measured, what other web GIS tools do, and the options, so the next design pass starts from the same facts.

## Goal

Project and builder views may start slowly. **Published maps, datasets and apps must load fast**, including for the first viewer. Realtime multi-user editing of the draft stays a preference (see "Direction").

## What we measured (isolated local backend, 20k points)

- Cold open of a fresh dataset: 16.5 s, down from ~32 s (#185). About 12 s is the worker reading geometry rows, about 4 s is the tile build.
- Import: 48.7 s down to 17.3 s (#195); redundant second tile build removed (#195); row-fetch and import progress shown (#196).
- The row read is a per-document database cost: roughly 1 ms per document, linear, and parallel queries add no throughput. Paging, parallelism and moving the code do not remove it. Only reading fewer documents does.
- Server-side archive build (phase 1 of `map-server-archive-build-design-2026-10-29.md`) was built and measured, then dropped: the default V8 action ran out of its 64 MB limit at 20k points, and a `"use node"` action made the cold open 28.6 s against 16.5 s for the browser worker (the action itself ran ~16 s versus ~2.4 s on Bun for the same data, cause not found). The browser worker was faster.
- Profiling showed no main-thread freeze. The site feels slow because of waiting, not blocking.
- Not measured: a 50k file, a polygon-heavy set, the `/maps` workspace, cloud or VPS timings (the plan is a self-hosted Convex on a VPS; expect similar per-document costs).

## What other tools do

Compiled from web research on 2026-10-29. Secondary sources are marked; none of the Felt posts could be read directly.

| Tool          | How data reaches the viewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GeoLibre      | Local-first and client-side. Uploads are parsed in the browser and handed to MapLibre as an in-memory source, with no server round trip. A shared project is one JSON file with inline GeoJSON; its docs say large data should be hosted by reference because every embedded feature is parsed on open. Large sources are PMTiles, FlatGeobuf or GeoParquet by URL. Live collaboration goes through an optional websocket relay on the whole project; conflict handling is not documented. |
| Felt          | Upload is processed once by a server pipeline into vector tiles (tippecanoe, PMTiles on a CDN); viewing reads tiles only. Zoom range and feature thinning are chosen automatically. (Secondary summaries.)                                                                                                                                                                                                                                                                                 |
| CARTO         | Dynamic tiles from SQL against the warehouse, or pregenerated tilesets for very large tables, a CDN in front for public maps. A per-tile query timeout returns an empty tile.                                                                                                                                                                                                                                                                                                              |
| Mapbox Studio | Upload becomes a tileset; viewing reads the tileset.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Placemark     | An editor, not a publisher. Features live in Postgres (no PostGIS) keyed by id, transactions coordinate editors, Replicache plus IndexedDB sync clients, hot paths are hand-written SQL.                                                                                                                                                                                                                                                                                                   |
| PMTiles       | One static file read with HTTP range requests from object storage or a CDN; no tile server.                                                                                                                                                                                                                                                                                                                                                                                                |

Common pattern: editing runs on a live store; viewing reads a prebuilt, versioned, cacheable artifact. GeoLibre's instant 20k upload is instant because nothing goes to a server, which does not transfer to published or shared maps. Details of the earlier survey: `docs/gis-geometry-transport-survey.md`.

## Where we differ

We already build PMTiles, but lazily: whichever browser opens a dataset first pays the row read and the build, then uploads the archive for everyone else. A published version is frozen and append-only, so it can have a fixed archive built ahead of the first viewer.

Not verified: that the published map and app views read only the archive, and that a first public viewer sees the ~16 s cold cost. Measure this first.

## Options

### A. Build the archive on the server when a version is published

Publishing records a frozen version; a job builds the archive from it and installs it with the existing version guard. Viewers read archive metadata, then range-read tiles. Any collaborator can trigger it and closing a tab cannot kill it.

- Needs a place with enough memory. A V8 action cannot (64 MB) and a Node action was slow. A small worker process on the VPS running the same builder (or tippecanoe) is the realistic home; it is a process, not a database.
- Idempotent and retryable, like the existing publish run. Frozen versions mean no edit conflicts.
- Browser-side publish-time build was rejected: publishing should not depend on one person's browser.

### B. Render and build at import from the importer's own data

At import the browser already holds all parsed features.

- Draw the map from memory immediately while the server import runs (GeoLibre's behavior). Whoever imported sees the map at once. Row popups need the server import done.
- Build the archive at import using client-assigned row keys (UUID or an indexed stable key) as the tile join key, so no row read-back is needed. Today tile features carry the server-assigned entry id, which blocked a browser build at import. Requires a new indexed field; untested.
- Helps the importer only. A first viewer of a published map still needs A.

### C. Packed snapshot plus a change feed (keeps realtime)

The server periodically writes a packed snapshot of the draft at a version; clients load that one file, then subscribe to changes since that version. This is the Linear/Replicache model.

- Fast load, and edits and maps run on a local copy.
- Needs a version on every row edit and tombstones for deletes. We have `mapTileCacheVersion` for geometry changes; what exists for general row edits is unchecked.
- `docs/map-geometry-snapshot-design-2026-10-29.md` covers the first half (snapshot at import). It was shelved because it sat beside live edits, but is the base of this option.

### D. Git-style local-first projects

Open a project, edit locally, then push/merge and resolve conflicts at save time, like Kart (git for geospatial data) or Dolt (git for tables). Local data in OPFS plus DuckDB-WASM; commits are immutable snapshots, so publishing is a server archive build from a blob.

- Fast editing and maps, simple publishing, offline.
- Costs: merge rules for rows, cells, deletes against edits, schema changes and geometry; a conflict UI for non-technical users; a browser memory ceiling (hundreds of thousands of rows fine, millions not); no realtime editing; a very large rewrite because Convex becomes the remote, not the live database.
- CMS-style row editing does not fit a push-and-merge save. Row edits should save immediately with a separate publish step, so any adoption would be a hybrid: C for the draft, D only for bulk change sets.
- Two spikes would de-risk it: load 20k, 100k and 500k rows into OPFS plus DuckDB-WASM and time load, filter and tile build; and write the merge rules as a short spec tested against two-person scenarios.

### E. Postgres/PostGIS beside or instead of Convex

Covered separately in `docs/postgres-supabase-backend-notes-2026-10-29.md`.

### Smaller items regardless of option

- **#188 clustering:** a tile size budget (tippecanoe caps tiles at 500 KB and thins dense points) and an automatic maximum zoom per dataset. The budget is the real fix for dense layers.
- **#186 remainder:** one-shot reads and a single `mapTileCacheVersion` live signal in place of N live page subscriptions. Low value now that the row path only serves under 5k features, derived layers, stale or failed archives.
- **Local caching:** OPFS already caches archives; local copies of datasets would help repeat viewers.
- **Felt's real-time editing of tiled data** ("Lightning") is worth reading before designing edits on top of archives; only its title was seen.

## Direction (as of 2026-10-29)

- Realtime multi-user editing of the draft is still the preference; git-style merging was considered and not adopted.
- Do not adopt a second database or a Postgres rewrite yet. Triggers to revisit: datasets reaching millions of rows; server-side attribute or area filtering in maps; edit-to-published-tile latency of a second or two.
- Likely next steps, in order: (1) measure what a first public viewer of a published map pays today; (2) design A, the server build job; (3) B for the importer's experience; (4) C if load time of large drafts matters.

## Open questions

- What does a first public viewer pay today?
- Is the Node action's slowness (16 s versus 2.4 s on Bun) fixable, which would make the build job a plain action instead of a worker process?
- What change tracking exists for general row edits?
- Cold-open and import timings on the real VPS deployment, the 50k file, and a polygon-heavy set.

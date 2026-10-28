# Map performance audit — large point datasets (2026-10-28)

Follow-up to [the 2026-09-16 audit](map-performance-audit-2026-09-16.md),
which targeted a few hundred large polygons. This one targets **many small
rows**: a user imported 20k points and the map "takes forever and slows the
page down". None of the open issues (#158–#169, #137, #82, #78, #72) cover
this; the September issues (#48–#55) are all closed.

## How it was measured

- Isolated local backend (fresh `perf.sqlite3`, same binary as dev), app via
  `vite dev` pointed at it, signed in as a test account. Nothing touched the
  cloud dev deployment's data.
- Synthetic GeoJSON points spread over the continental US, 5 properties each:
  5k (0.96 MB), 20k (3.9 MB), 50k (9.7 MB). Imported through the real
  create-dataset UI.
- In-page probe on the dataset page: 100 ms timer for main-thread lag, "Loading
  features…" visibility, `performance.memory` heap. Server timings via
  `convex run --component jsonCms entries:listGeometries`.
- Caveat: server timings are from the local (SQLite) backend. Cloud
  per-operation cost is likely lower, but the failure below is a count of
  sequential reads per query, so it still applies (unverified on cloud).

## Findings

### 1. Root cause — the geometry paginator reads 5 rows at a time

`takeGeometryRows` (`packages/json-cms/src/component/internal/geometryPages.ts`)
sizes every `.take()` as
`min(maxRows, 8, floor(remainingBytes / INLINE_GEOMETRY_BYTE_LIMIT))`. With a
5 MB page budget and a 900 KB worst-case row, that's **at most 5 rows per
take**, whatever the real row size. A point row is ~60 bytes.

| `listGeometries` page size | Before | With 100-row takes (experiment) |
| --- | --- | --- |
| 100 rows | 3.5 s | 0.4 s |
| 300 rows | 10.0 s | — |
| 500 rows | **fails after 15 s**: "timed out performing too many system operations" | 0.8 s |

(Wall times include ~0.3 s of CLI overhead.)

Consequences:

- **The tile archive is never built for small-row datasets.** The build
  worker asks for 500-row pages, so every build fails at the first page. The
  toast is `Tile rebuild failed … cms/geometries:list … too many system
operations`. The dataset is stuck on the row path, and the build is retried
  (and fails again) on every view. This affects any dataset over ~350 small
  rows. Polygon datasets escape it only because their byte budget ends pages
  early.
- **The row path is slow.** The browser asks for 200-row pages (~40 takes,
  ~6 s each on the local backend). 20k points means 100 serial pages, which
  is many minutes. After 56 s the 20k map was still "Loading features…".

### 2. Cold open still slow after fixing finding 1

With the experimental fix, the archive builds and later opens are fast. The
first open after an import or edit still pays for both paths at once:

| Dataset | Cold open (row path + in-browser build) | Peak JS heap | Warm open (tile path) | Warm heap |
| --- | --- | --- | --- | --- |
| 20k points | ~32 s until loaded (the archive landed first) | 517 MB | **1.3 s** | 238 MB |
| 50k points | still loading at 150 s; archive done ~150 s | 641 MB | **3.8 s** | 286 MB |

Causes:

- **Double fetch.** The main thread streams every row while the tile worker
  fetches the same rows again to build the archive.
- **N live subscriptions.** `useAllPaginated` (page size 200) keeps every page
  as a reactive `usePaginatedQuery` subscription: 100 for 20k rows, 250 for
  50k.
- **Quadratic rebuilds.** Each page arrival re-concatenates all rows, rebuilds
  the whole FeatureCollection and calls `setData` on the full source.
  Main-thread lag stayed under ~350 ms, so the cost shows up as heap and wall
  time rather than as a frozen tab.
- **Builds run in the browser.** The archive is built client-side by
  whoever opens the dataset first after an import or edit. Every import chunk
  bumps `mapTileCacheVersion` (40 bumps for 20k rows), which marks the archive
  stale until a client rebuilds it.

### 3. Other observations

- Import throughput is ~450 rows/s (20k ≈ 45 s, 50k ≈ 2 min). Acceptable for
  now and not part of the complaint.
- At low zoom, 20k–50k circles overdraw into a solid blob. This is
  readability, not load time. Clustering or zoom-scaled radius belongs with
  layer styles (#159/#169).

## Plan

Tracked in umbrella #182. Ordered by impact. Steps 1–2 alone turn "never loads" into "loads".

### P0 — Fix the paginator chunking (component) — #183

Size takes from the dataset's real worst-case row instead of the global
900 KB limit:

- Keep a monotonic `maxGeometryRowBytes` on the `schemas` row. Update it
  wherever a geometry row is written (the same paths that already patch
  `featureCount`/`boundingBox`), and add a backfill for existing rows. Where
  it's unknown, fall back to `INLINE_GEOMETRY_BYTE_LIMIT`, which is today's
  behavior.
- Set `requested = min(maxRows, max(1, floor(remainingBytes / maxRowBytes)))`.
  A points dataset then fills a 500-row page in one take. The overshoot bound
  stays at one worst-case row, so the 16 MiB read limit remains safe.
- Tests: a convex-test case with ~2k tiny rows asserts a 500-row page comes
  back intact in one call. Keep the existing big-row overshoot tests.
- Consider deleting `GEOMETRY_PAGE_CHUNK_ROWS = 8`, which no longer earns
  its place.

### P0 — Make build failures visible and bounded (app) — #184

- Back off after a failed build (for example, retry after 1 m, 5 m, 30 m)
  instead of retrying on every view. Show a persistent "map tiles failed to
  build" state, not only a toast.

### P1 — Don't stream rows for big datasets (app) — #185

- Decide by `schemas.featureCount`. Above a threshold (start at ~5k features,
  tune by measuring), skip the row path. Show the map at the stored
  `boundingBox` with a "Preparing map tiles…" chip and wait for the archive.
  Below the threshold, keep today's row path.
- Let the build worker hand its fetched features to the map, or share one
  fetch between the two, so a cold open fetches the data once.

### P1 — Cheaper row path where it remains (app + json-cms react) — #186

- Raise the geometry `useAllPaginated` page size to the server's 500-row
  ceiling, which cuts round trips 2.5×.
- Read geometry with one-shot queries (the worker's
  `forEachDatasetGeometryPage` loop) instead of N live paginated
  subscriptions, plus a single live "version changed" signal
  (`mapTileCacheVersion`) to re-read.
- Throttle `setData` (for example, every 250 ms or every 5k new features)
  instead of on every page.

### P2 — Build archives server-side (component, larger) — #187

- Build the archive in a Convex action at `handleImportComplete`, and after
  debounced edits, rather than in whichever browser opens the dataset first.
  This removes the cold-open double fetch entirely. It needs geojson-vt plus
  our PMTiles writer in a Node action, and must respect action memory and
  time limits; measure on 50k points before committing.

### P2 — Point readability at low zoom (layer styles) — #188

- Offer clustering or zoom-scaled radius for dense point layers on both the
  row and tile paths. Related to #169.

## Verification for each step

Re-run this audit's recipe: an isolated backend, the 20k/50k generated files,
the cold and warm dataset-page probe, plus the `/maps` workspace with the
dataset as a layer (not measured this round). Targets: the 20k cold open
under 10 s, no `listGeometries` failures, and warm opens unchanged.

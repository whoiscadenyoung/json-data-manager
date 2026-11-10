# ADR 0025: Row-path geometry loading moves off the main thread (worker offload, sized takes)

Date: 2026-11-10 · Status: accepted · Issue: [#287](https://github.com/whoiscadenyoung/json-data-manager/issues/287) ([remedies 1], the implementation half of #284) ·
Train: [remedies umbrella #286] · Companion: `docs/remedies-followup-handoff.md` item 1

## Context

The row path — `PgGeometriesLoader` fanning per-dataset pagers over
`dataset_rows_for_tiles` — is what a map renders from whenever its dataset
has no servable tile archive. The Planning-grants map (#284) freezes the
page because four big polygon datasets ride it: 450–640 features at
0.7–3.3 MB per row, ~21–26 MB of GeoJSON per dataset, handled entirely on
the main thread in four stacked passes:

1. supabase-js `res.json()` per PostgREST page (the whole dataset lands in
   1–2 pages);
2. storage-backed rows fetched and `response.json()`-ed per payload
   (`resolveGeometryRows`);
3. a per-row `JSON.stringify` into `geometryJson`
   (`pgGeometryToLayerRow`);
4. a per-row `JSON.parse` of that string again in `useResolvedGeometries`.

Separately, the same datasets never got OFF the row path because tile
archives never install anywhere: `install_tile_archive`'s path guard
demanded the bucket-QUALIFIED form (`tile-archives/<id>/…`) while the
worker uploads, the stored column, and every signed-URL reader use the
bucket-RELATIVE convention — the RPC raised on every install, the #184
backoff plateau retried forever, and each retry leaked an orphan object
(214 objects, ~1.9 GB, on the dev stack since 2026-11-05). Fixed by
migration 0026 on the same branch.

## Decision

1. **Worker offload with a structured-clone hand-off.** A dedicated
   row-path worker (`pg-geometry-rows.worker.ts`) owns paging, payload
   resolution, and parsing; pages cross to the main thread as PARSED
   geometry objects (`PgGeometryWorkerRow`), and the seam's layer rows
   carry them as `geometryResolved` (`pg-layer-rows.ts`,
   `useResolvedGeometries` prefers them). Steps 1–3 leave the main thread
   entirely; step 4 never runs. Structured clone is the only remaining
   copy — cheaper than the stringify→parse round trip and free of JSON
   lexing. The report contract (`onLoaded`, `complete` latching,
   `servedGeometries` streaming) is unchanged, so `useGeometriesByPgDatasets`
   consumers and the #285 loading-state gates keep their shape.
2. **Run tokens over shared subscriptions.** Each queryFn run posts a
   `runId`; the worker aborts a superseded run between pages and echoes
   the token on every event, so stragglers from a cancelled pass are
   dropped instead of double-accumulated. Invalidations ride the OLD
   query key (`["pg:geometries","rowsForTiles",…]`) — the entry form's
   `invalidateQueries` re-runs a pass exactly as it re-paged before.
3. **Sized takes in the build worker only.** The tile-archive build's
   fetch phase pages under a 16 MB payload budget (budget ÷ the dataset's
   `maxGeometryRowBytes`, #183's take-sizing mechanism,
   `geometryTakeRowsFor` — previously consulted by no PG read path).
   Build latency tolerates the extra round trips (a debounced background
   job with progress reporting); a multi-gigabyte single response does
   not. The ROW-path loader deliberately keeps the tile feed's default
   5000-row width: its parse lives in the worker, and per-page map-land
   updates are an O(pages²) main-thread cost — each dataset's arrival
   rebuilds and re-serializes the whole growing FeatureCollection through
   maplibre's `setData` (verified live: take-sized pages froze the page
   harder than the old single-page path). Progressive fill happens per
   DATASET, not per page.
4. **Chunked main-thread parse: rejected.** Time-slicing cannot split a
   multi-megabyte `JSON.parse` without a custom incremental parser, and
   even sliced it re-pays steps 3–4. Simpler and strictly worse than the
   worker here.
5. **Read-time simplification: deferred, not decided in.** Stored
   geometry is 6 dp but vertex-dense; decimating at read time changes
   rendered fidelity (a product call, not an engineering one) and the
   user-facing lever already exists (the #45 simplify workflow's
   dataset-copy). Revisit only if a throttled-environment check after
   this change still starves the map; #284's acceptance covers it.

## Consequences

- The main thread's per-dataset work drops to receiving structured clones,
  mapping row metadata, and ONE maplibre `setData` per dataset — the
  serialization inside `setData` remains the dominant last-mile cost (~1–2 s
  for a 25 MB dataset on an M-series). If that ever needs to go too, the
  lever is handing maplibre a blob: URL built from a worker-serialized
  string (its own worker then parses), or incremental source updates —
  both deferred; #284's acceptance is responsiveness, not zero main-thread
  work.
- Two worker modules now share the token-bridge protocol shape (the
  tile-archive worker's); the duplication is deliberate — extracting a
  shared bridge would couple two independently-shipped workers for ~40
  lines.
- `map_tile_archive_path`'s stored convention (bucket-relative) is now
  enforced by the RPC guard instead of contradicted by it (migration
  0026); the int tests pin all three path classes.
- Orphaned pre-0026 archive uploads are unreferenced by any row; the dev
  stack's accumulated objects were swept by hand (2026-11-10). A periodic
  orphan sweep remains open as follow-up hygiene.

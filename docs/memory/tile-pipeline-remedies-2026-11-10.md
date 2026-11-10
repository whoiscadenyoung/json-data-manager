---
name: tile-pipeline-remedies-2026-11-10
description: "Why PG tile archives never installed (three stacked causes: bucket-qualified path guard vs bucket-relative convention; published-only feed hiding draft datasets from the scheduler; main-thread row-path freeze) and the #287 fixes + live-verification recipe"
metadata:
  type: project
---

2026-11-10, [remedies 1] (#287, ADR 0025) on branch `feat/remedies-1-row-path-worker`.
"Archives never build" on PG deployments was THREE stacked causes, each
invisible while the others held:

1. **`install_tile_archive`'s path guard demanded the bucket-QUALIFIED form**
   (`tile-archives/<id>/…`) while the worker uploads, the stored
   `map_tile_archive_path`, and every signed-URL reader use the
   bucket-RELATIVE convention (`<id>/…`). Every install raised → #184
   backoff plateau retried forever → one orphan upload per attempt (248
   objects ≈ 2.1 GB swept 2026-11-10). Fixed by migration 0026; the int
   tests now pin all three path classes (relative ok, foreign-dataset
   raises, bucket-qualified raises). Lesson: when an RPC validates a path
   convention, derive the test's path from the PRODUCER's helper, not by
   hand.
2. **The tile manager's summaries feed was published-only**
   (`listSummaries`' load-bearing `lifecycle eq 'published'` — the stage-4
   drafts-leak fix). Project-held draft datasets (#276 posture) never got
   scheduled: their maps rode the row path forever. Fixed by
   `tileWatchSummariesQueryOptions` (no lifecycle gate — RLS scopes) +
   `usePgTileDatasetSummaries`; both tile consumers (manager, OPFS pin)
   switched. The catalog feeds keep the published gate.
3. **The row path froze the main thread** (parse chain: RPC res.json →
   per-row stringify → per-row re-parse). Fixed by the row-path worker
   (`pg-geometry-rows.worker.ts`), parsed-geometry hand-off
   (`geometryResolved`, structured clone), wide pages (per-page map-land
   updates are O(pages²) — sized takes live ONLY in the build worker's
   fetch).

Live verification recipe (all on localhost): sign in as reviewer, open the
Planning map — loaders must complete (pill clears), and after builds land
the map renders via PMTiles (`performance` resource entries hit
`tile-archives`; `datasets.map_tile_archive_built_version = cache_version`
for all four: 0093bbbd/7773e857/c23e38aa/199abd77). Build math is fine:
FY22's 450 features → 18.8 MB archive in ~34 s (bun repro outside the
browser).

Gotchas hit on the way: `storage.objects` carries a delete-protect trigger
(`storage.protect_delete`) — bulk sweeps need
`SET session_replication_role = replica` (the dropDatasetsBulk pattern);
the stub storage backend stores each object as a DIRECTORY (content inside
a version-named file) so `test -f`/`cat` on the object path lies;
`scripts/local-gate.sh` must run from the REPO ROOT (exit 127 from app/);
the local-gate can race mid-flight working-tree edits — land all edits
before launching it.

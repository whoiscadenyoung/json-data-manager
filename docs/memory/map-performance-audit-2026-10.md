---
name: map-performance-audit-2026-10
description: 2026-10-28 large-point-dataset audit — geometry paginator took only 5 rows per .take() (900 KB worst-case guard), so 500-row pages timed out and tile archives never built for small-row datasets; FIXED by #183 (maxGeometryRowBytes + backfill); plan in docs/map-performance-audit-2026-10-28.md; isolated-backend recipe gotchas
metadata:
  type: project
---

Audit of "20k points takes forever on the map" (2026-10-28). The full write-up
and plan are in `docs/map-performance-audit-2026-10-28.md`. The plan is filed
as umbrella #182, with children #183–#188 (label `performance`). #183 is the
P0 paginator fix and should land first. Follows
[[map-performance-audit-2026-09]].

**Root cause:** `takeGeometryRows` caps each take at
`floor(5 MB / 900 KB) = 5` rows. On the local backend a 500-row
`listGeometries` page takes ~100 sequential takes and fails with "too many
system operations". So the tile worker (500-row pages) never builds an
archive for datasets over ~350 small rows, and the row path (200-row pages)
crawls. An experiment with 100-row takes measured 15 s (failure) → 0.5 s per
page; warm tile opens were then 1.3 s (20k) and 3.8 s (50k). Cold opens were
still 32 s / 150 s+ because the row path and the in-browser build double-fetch
over N live subscriptions. The planned P0 fix is a monotonic
`maxGeometryRowBytes` on `schemas` to size takes.

**#183 shipped 2026-10-28:** `schemas.maxGeometryRowBytes` (absent =
unknown → 900 KB fallback; writers leave absent alone, born/cleared = 0,
otherwise only grows) sizes takes; 500-row point pages are one take (1.2 s
CLI), the 20k archive builds, warm open ~1.5 s. Pre-field datasets need
`bunx convex run cms/schemas:backfillGeometryRowBytes` (from app/); it
measures with the conservative sizing, ~200 s per 20k rows on the local
backend. Component `_generated/component.ts` was hand-edited because
`convex codegen --component-dir` needs a configured deployment.

**Isolated-backend recipe gotchas (learned the hard way):**

- When the CLI is logged in, `CONVEX_AGENT_MODE=anonymous bunx convex dev`
  still targets `CONVEX_DEPLOYMENT` from `.env.local`. It pushed functions to
  the cloud dev deployment `woozy-husky-92` twice that day. Emptying
  `.env.local` didn't help either.
- What works: run the backend binary directly (as in [[better-auth-setup]],
  cwd `app/.convex/local/default/`, a fresh sqlite file plus
  `--local-storage <dir>`). Then use `--env-file <file with
CONVEX_SELF_HOSTED_URL/ADMIN_KEY>` for `convex dev --once`, `env set` and
  `run`.
- `convex dev --once --env-file` still REWRITES `app/.env.local` (VITE URLs →
  127.0.0.1, drops `CONVEX_DEPLOYMENT`). Back it up first and restore it after.
- Run vite with `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL` env overrides instead
  of editing `.env.local`. `SITE_URL` must match the actual port.
- The in-app browser pane CAN reach localhost now. File imports work by
  serving the file with CORS from a scratch Bun server, then
  `DataTransfer` → `input.files` → a `change` event.
- `convex run --component jsonCms entries:listGeometries` times component
  queries directly with admin auth.

**#184 FIXED 2026-10-28 (build-failure backoff):** `TileArchiveScheduler`
(`packages/maps/src/build-scheduler.ts`) now backs off per dataset after a
thrown build: retries at 1 m, 5 m, then every 30 m
(`TILE_ARCHIVE_FAILURE_BACKOFF_MS`). `schedule()` triggers at the failed
`mapTileCacheVersion` are absorbed while backing off; the backoff's own timer
runs the retry. A newer version resets it, and so does a newer version queued
during the failing build. `ensure()` (import immediacy + the manual Retry)
skips the wait but keeps the count. The app's manager keeps a persistent
failure record (`useMapTileArchiveBuildFailure`, fed by the scheduler's
`onBackoff`). It is cleared only by an installed or skipped build, and it
toasts only the first failure of a streak. `TileBuildStatus` shows it as a
"Map tiles failed to build" alert with the error, the next retry time and a
Retry button. The chip only mounts on the dataset page; the `/maps`
workspace has no build-status surface yet. The scheduler is in-memory, so the
backoff (plus the error message) is persisted per browser in localStorage
`tile-archive-backoff` and re-armed with `restoreBackoff` when the scheduler
is created. Without that, every page reload bought a failing dataset a fresh
attempt (found in browser verification). Verification recipe: a temporary
patch that throws in `runBuild` behind a localStorage flag. Bump the version
by re-saving an entry with `convex run --component jsonCms
entries:updateEntry` (admin, isolated backend). `preview_start {name}` reads
the MAIN checkout's `.claude/launch.json`, whose `dev` config runs `convex
dev` against the cloud deployment. For isolated testing, run vite from Bash
with env overrides and open it with `preview_start {url}`.

Review follow-ups (same PR): the alert and badge moved to top-left at z-5, so
the feature-details panel (top-right, z-10) always wins. The manager calls
`scheduler.clear()` and drops the failure for any dataset that reads current,
because another tab or user may have built it. A failure from `ensure()`
before any `schedule()` (version 0) adopts the first version seen instead of
being reset by it. `dispose()` stops a late-settling build from arming
timers. **Known limit:** backoff state is per tab. With N tabs open, each tab
has its own scheduler and worker, so a failing dataset is fetched N times per
window. Storage is read only when a tab's scheduler starts, so tabs don't
share a live window. A reload does keep the backoff (localStorage restore).

**Import speed 2026-10-29:** a 20k-point import took ~48 s because `importWorkflow`
ran one workflow step per 500-row chunk: ~0.25 s of real work but ~0.9 s of
step scheduling latency each (40 steps). `insertChunkGroup` now inserts 8
chunks per step (`IMPORT_CHUNKS_PER_STEP`): 17 s, all 20000 rows landed. The
app loads the component from `packages/json-cms/dist`, so run `bun run build`
there before `convex dev --once` or the old workflow stays deployed. Progress
now updates every ~4000 rows. Also measured: server-side archive builds
(a `"use node"` action) were slower than the browser worker (28.6 s vs 16.5 s
cold open); the V8 runtime OOMs at 64 MB for 20k points.

---
name: map-performance-audit-2026-10
description: 2026-10-28 large-point-dataset audit — geometry paginator takes only 5 rows per .take() (900 KB worst-case guard), so 500-row pages time out and tile archives never build for small-row datasets; plan in docs/map-performance-audit-2026-10-28.md; isolated-backend recipe gotchas
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

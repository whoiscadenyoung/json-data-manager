---
name: supabase-stage6-realtime-notes
description: 2026-11-04 stage-6 review fix — realtime enablement (0012), the kong/minted-JWT auth split on CLI-v3 stacks, realtime backlog semantics, and the shared-stack reset collision
metadata:
  type: project
---

Four durable facts from the stage-6 review-fix run (PR #214, commit 5042f5d):

1. **Enablement + health check.** `postgres_changes` delivers nothing until the
   matrix tables join `supabase_realtime`; the subscribe fails with the
   misleading "Unable to subscribe to changes … check Realtime is enabled".
   `supabase/migrations/0012_realtime_publication.sql` adds all eight
   DATASET_CHANNEL_TABLES tables (guarded create-if-missing + add-if-missing,
   both transactional). Health check:
   `select count(*) from pg_publication_tables where pubname='supabase_realtime'`
   → 8. `pg-realtime.int.test.ts` is the committed live-stack proof (delivery +
   per-subscriber RLS negative + tile signal + payload column sets).
2. **CLI-v3 stack auth split (verified live).** Kong's REALTIME route rejects
   the legacy demo anon JWT ("Failed to validate JWT signature") — use the
   publishable key `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH` (fixed
   CLI local default; REST still accepts legacy JWTs). Minted HS256 user JWTs
   (demo secret `super-secret-jwt-token-with-at-least-32-characters-long`)
   authenticate REALTIME subscriptions (JWKS oct key) but PostgREST ignores
   them (ES256-only) → int tests subscribe with minted JWTs and WRITE via the
   PG wire client (pg-int-helpers' asUser). Node's WebSocket can't send
   headers — kong wants the apikey in the query string; /realtime/v1 has no
   HTTP health route (404), so probe by subscribing.
3. **Realtime backlog semantics (v2.151.3, walrus poller).** The phoenix join
   resolves BEFORE the server-side postgres subscribe completes — a write in
   the join's shadow delivers nothing (wait ~1.5 s after SUBSCRIBED). A new
   subscription's first poll flushes a BACKLOG of pre-subscription slot
   changes (including the fixtures' own trigger updates, e.g. an entries
   INSERT bumps the datasets row) → event assertions must match the CHANGED
   VALUE, not the row id. Full-suite runs flood the shared slot: isolated
   delivery 132–398 ms, but under parallel int-test load give events 15 s.
4. **Shared-stack reset collision.** A concurrent worktree's `supabase db
reset` silently replaces the applied migration set with ITS tree (stage-7's
   0012_bound wiped this branch's 0012 mid-verification; containers stay up,
   nothing logs it). 0012 is idempotent — re-applying its SQL restores
   publication membership without a reset war. Migration numbering: stage-6's
   0012_realtime + stage-7's 0012_bound collide by number only (different
   filenames, both apply in filename order); stage-7 should renumber to 0013
   at merge. Realtime §16 numbers recorded in PR #214: 12 subscribers ×
   8-table matrix subscribe in 84 ms; delivery p50 405 / p95 682 / max
   688 ms over 20 writes × 11 permitted subscribers.

Related: [[supabase-migration-2026-11-03]], [[supabase-stage1-sql-gotchas]],
[[supabase-stage3-catalog-notes]], [[bun-cwd-flag-placement]].

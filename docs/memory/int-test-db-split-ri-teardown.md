---
name: int-test-db-split-ri-teardown
description: "Int suites need a CI-parity DEDICATED db (live compose db fails the count/closure assertions with inflated rows); FK RI triggers cost ~1.3 ms per deleted entry row (5 FKs × rows) so 20k-row teardowns need dropDatasetsBulk (replica role), not the datasets cascade"
metadata:
  type: project
---

2026-11-09, PR #273 CI red (pg-relations perf + realtime-absence timeouts; main failed the
same two tests 2026-11-07 — pre-existing cliff, not a PR regression). Two durable facts:

1. **Int suites require a dedicated CI-parity db.** The `pg-*.int.test.ts` count/closure
   assertions ("foreign user reads zero rows", "anon sees 0 live rows") assume CI's bare
   service container. Against the live compose db they fail with the app's real data
   inflation (`expected 0 … got 40016`). Recipe: throwaway
   `public.ecr.aws/supabase/postgres:15.19.0.016` (+ storage-api v1.88.0 on the same
   docker network, booted BEFORE migrations so 0004/0006 apply their storage sections),
   apply `supabase/migrations/*.sql` in LC_ALL=C order, then
   `SUPABASE_DB_URL=postgresql://supabase_admin:postgres@127.0.0.1:<port>/postgres bun run test`.
   The compose db (kong :8000) is the APP's db — docker-compose.override.yml now publishes
   it on 127.0.0.1:54322 for quick single-file runs only.

2. **FK RI-trigger teardown cost is ~1.3 ms per deleted entry row** (on the local Docker
   stack; CI postgres probes faster — the pre-fix perf test ran ~82 s GREEN on CI, so
   CI's RI portion was ~30-50 s). entries.id carries five child-side FKs (geometries,
   entry_references ×2, version_entries, binding_entries); deleting a 20k-entry dataset
   via the `datasets` cascade fires ~100k RI probes. Not indexes (all relevant FKs
   indexed; GIN irrelevant). `pg-int-helpers.int.test.ts` ships `dropDatasetsBulk`
   (session_replication_role = replica on the superuser admin session, children deleted
   explicitly in FK order) — perf fixtures use it; the perf test went 111 s → 3.9 s
   locally. On a timed-out test the abandoned teardown stays queued on the shared
   per-file session socket and wedges the NEXT test (the trailing 5 s timeout pattern).

3. **The perf test also has an independent CI-only variance cliff**: even after the
   teardown fix, CI still burned the old 120 s budget (e5ae15a added per-phase console
   marks + a 240 s budget for exactly this). All three reds (2026-11-07 ×2, 2026-11-09)
   were this one test at a silent test-level timeout while every other int file ran
   60 ms-1.5 s on the same runner; green baseline ~82 s. Prime suspect: the explicit
   ANALYZE / vacuum-analyze queueing on the tables' ShareUpdateExclusiveLock behind
   autovacuum (insert thresholds crossed by the 20k seed + ~20 int files of churn
   before it). The marks will name the blocked phase if it recurs; don't remove them.

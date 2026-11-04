---
name: supabase-stage1-sql-gotchas
description: 2026-11-03 stage-1 core-schema build — PG restrictions and RLS
  traps hit while writing migrations 0002/0003, and the zero-dep wire-client
  pattern the *.int.test.ts files use
metadata:
  type: project
---

Learned building the stage-1 datasets+rows core
(`supabase/migrations/0002_profiles.sql` + `0003_core_schema.sql`, verified
against the local stack, docs/supabase-migration-design.md §3.2/§4/§5):

- **Transition tables (statement-level triggers) forbid two things** (both
  PG-verified): multi-event triggers (`after insert or delete … referencing`
  errors "transition tables cannot be specified for triggers with more than
  one event") and `update of <column>` lists. Split one trigger per event;
  the trigger FUNCTION may still dispatch on `tg_op`.
- **FK-cascade deletes DO fire statement-level triggers** with the full
  cascaded row set in `old table` — that's why the count/bbox/tile-version
  maintenance stays exact through `on delete cascade` paths.
- **Generated columns compute AFTER BEFORE-row triggers** (`NEW.geom` is
  null in a BEFORE trigger) — per-geometry `bbox` fill happens in the
  statement-level AFTER trigger, guarded by `pg_trigger_depth() > 1`.
- **`st_envelope` degenerates** to POINT/LINESTRING for single-point /
  collinear extents, which a `geometry(Polygon,4326)` column refuses —
  build envelopes with `st_makeenvelope(st_xmin…, st_ymax…, 4326)`.
- **RLS `with check (can_edit_dataset(id))` can never pass for the datasets
  INSERT policy** — the function reads the table, the row isn't there yet;
  the policy re-states the predicate over the new row's own values.
- **edit_policy flips are creator-only** (the setEditPolicy rule,
  app/convex/cms/schemas.ts:478): plain `can_edit_dataset` UPDATE would let
  any collaborator lock an open dataset — enforced with an `as restrictive`
  UPDATE policy (`edit_policy = 'open' or created_by = auth.uid()`).
- **RLS denial shapes**: filtered UPDATE/DELETE succeed with "UPDATE 0"
  (the §4 "reads as not found" shape); INSERTs and column-constrained
  policies raise. The int tests treat both as denials.
- **Stage-0 shipped extensions only** — profiles (§3.1) + the §4 helpers
  landed as `0002_profiles.sql` in stage 1. The supabase/postgres image
  bakes auth-schema.sql (auth.users, roles, auth.uid()), and `postgres` can
  create triggers on auth.users, so no DO-guards are needed for CI's bare
  service container.
- **vitest workers run plain node** (`bunx vitest run` — verified execPath),
  so `import { SQL } from "bun"` fails to resolve and Bun.SQL is absent.
  With `bun add` off-limits, the pg-*.int.test.ts files share a minimal
  Postgres wire client (node:net + SCRAM-SHA-256, simple query protocol) in
  `pg-int-helpers.int.test.ts` (kept under the allowed *.int.test.ts pattern
  with one skipped placeholder test). Tests switch roles per transaction
  (`set local role authenticated` + request.jwt.claims) — no GoTrue needed;
  works against CI's service container via SUPABASE_DB_URL.

Related: [[supabase-migration-2026-11-03]].

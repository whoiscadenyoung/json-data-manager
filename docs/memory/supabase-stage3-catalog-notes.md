---
name: supabase-stage3-catalog-notes
description: 2026-11-04 stage-3 catalog build — the deferred datasets.group_id
  needed its UPDATE column grant, the wire client pipelines one statement at a
  time, and other int-test gotchas hit building 0007 + the catalog stores
metadata:
  type: project
---

Learned building the stage-3 catalog (`supabase/migrations/0007_catalog.sql`

- the collections/groups/profiles stores, worktree `jdm-supabase-stage3`,
  docs/supabase-migration-design.md §3.4/§4):

* **A column added in a LATER stage needs its column grant re-visited.** 0003
  revoked `UPDATE` on datasets and re-granted a column list; the sketch's
  stage-3 `datasets.group_id` was not in it, so `set group_id` failed with
  "permission denied for table datasets" (a privilege error, not RLS) until
  0007 added `grant update (group_id) on public.datasets to authenticated`.
  Any stage that adds a client-writable column to a grant-managed table must
  add the grant in the same migration.
* **The int-test wire client is single-pipelined**: one unawaited helper call
  interleaves its response frames into the NEXT statement's parse (symptom:
  `count(*)` "returned no rows" / column names reading back undefined). Every
  statement in a `pg-*.int.test.ts` test must be awaited.
* **The wire client returns booleans as text `"t"`/`"f"`** (not "true"), and
  `set_updated_at` stamps `now()`, which is TRANSACTION-constant — updated_at
  movement cannot be asserted from inside one test transaction; assert the
  trigger's existence in pg_trigger + `updated_at >= created_at` instead.
* **DB-vs-component idempotency split**: the join PK makes duplicate
  memberships ILLEGAL in raw SQL (23505); the addSchemaToCollection no-op
  parity lives in the store's `ignoreDuplicates` upsert, not the database.
* **The tranche builders SHARE one worktree** (catalog-UI builder wrote
  features/catalog/ while this stage wrote lib/store/) — oxlint/tsc snapshots
  race the other builder's in-flight writes (a phantom "unused import" that
  resolves seconds later); re-check before "fixing" their files.
* Component-parity deviations recorded for review: deleting a collection
  FLOATS its groups (binding DDL `on delete set null`) where the component's
  deleteCollection deleted them, and map layers pointing at deleted
  catalog rows survive as tolerated dangling targets (0005's FK-less
  target_id) where the component deleted them in its cleanup walks.

Related: [[supabase-stage1-sql-gotchas]], [[supabase-migration-2026-11-03]],
[[supabase-stage1-ui-wiring]].

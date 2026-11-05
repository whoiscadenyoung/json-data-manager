---
name: project-membership-0018-lessons
description: Migration/RLS authoring gotchas from #255 (0018 project membership) — self-table policy recursion, RETURNING-before-AFTER-trigger ordering, partial psql applies, realtime DELETE filter/identity rules, embed disambiguation
metadata:
  type: project
---

2026-11-05, #255 (0018_project_membership, PR #263). Five hard-won
migration/RLS facts, each caught live:

- **A policy on table T must be row-local or read OTHER tables.** An INVOKER
  helper reading T from a policy ON T recurses to `stack depth limit
  exceeded` (the policy subquery re-applies itself); a WITH CHECK helper
  reading T can't see the INSERT's own new row (the 0008 lesson's INSERT
  arm). `publish_bundles` policies are row-local through `project_id`
  (`can_view/edit_project`); the bundle helpers (`publish_bundle_viewable/
  owner`) are only for `publish_bundle_members`.
- **INSERT..RETURNING evaluates the SELECT policy BEFORE AFTER triggers
  fire.** The birth trigger's owner-membership row does not exist yet when
  RETURNING checks visibility — `projects` SELECT needed the row-local
  creator arm (`created_by = auth.uid() or can_view_project(id)`) or the
  store's `.insert().select("id")` create path refuses (caught by the
  stage-4 0008 RETURNING test).
- **`psql -f` applies statement-by-statement (no `-1`)** — a failed
  migration leaves a PARTIAL apply on the live stack; repair by re-running
  the tail (`create or replace` the touched functions, then everything from
  the failure onward). The 0018 backfill failed under the unconditional
  `stamp_created_by`-style trigger (admin path → `auth.uid()` null → NOT
  NULL violation): stamp triggers that must admit migration/admin writers
  guard on `auth.uid() is not null`.
- **Realtime column-filtered channels never deliver DELETEs under DEFAULT
  replica identity** — the filter is evaluated against the old row's image,
  which carries the PK only, so `project_id=eq.X` never matches a DELETE
  (silently dropped). `project_members` rides REPLICA IDENTITY FULL (rows
  tiny). Second, unfixable at the DB: DELETE delivery FAILS OPEN across
  per-subscriber RLS (the row is gone; the check can't run) — outsiders
  subscribed to the exact topic receive DELETEs. Client boundary: only
  member-visible surfaces ever open the channel. INSERT/UPDATE ARE
  policy-filtered (asserted in pg-realtime.int.test.ts).
- **PostgREST embeds on a table with TWO FKs to the same target need
  `!fk_name` disambiguation** — bare `profiles(...)` on project_members
  (user_id + added_by) fails PGRST201; use
  `profile:profiles!project_members_user_id_fkey(...)`.

Also: this host has TWO stacks — the live compose `jdm` (kong :8000, DB
`app`, container-internal) and the stale CLI stack (:54321 kong / :54322 db
`postgres`, the int tests' default target). Migrations drift between them;
apply new files to both (the stale one's history is drifted — 0017's bare
`drop function` needed a stub overload to apply). Fixture users for the
wire-client tests: ALICE/BOB/CAROL constants in
pg-int-helpers.int.test.ts.

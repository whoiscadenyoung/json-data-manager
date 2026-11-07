---
name: project-visibility-0023-lessons
description: "#260 gotchas: policy subqueries read zero anon rows (definer helpers), SQL function bodies validate against the live schema (create helpers before they're referenced), additive column grants need the later migration's columns too, and the fixture identity lessons the 0009 stamp teaches again"
metadata:
  type: project
---

Migration/RLS authoring gotchas from the visibility ladder (#260, migration
0023, ADR 0022 — 2026-11-06):

- **A `to anon` policy's inline subquery reads ZERO rows forever.** Policy
  subqueries evaluate under the INVOKING role, and the live tables carry no
  anon policies — `exists (select 1 from datasets …)` inside an anon policy
  is vacuously closed. The parent checks must live in SECURITY DEFINER
  helpers (`published_dataset_anon_visible` etc., 0023 §5) — the same reason
  the 0003 can_* helpers are definer functions. The authenticated-side
  subqueries compose fine (they ride the parent's own wider arms).
- **SQL function bodies validate against the live schema at CREATE time.**
  Re-issuing `can_view_dataset` while it references a helper created two
  statements later fails — order helpers BEFORE their first reference, and
  re-issue the gate before dropping the column its old body referenced.
- **A column-grant re-issue must carry the LATER migrations' columns.**
  0003's datasets UPDATE grant list + 0007's additive `grant update
(group_id)` — re-granting the 0003 list after a `revoke update` silently
  strips `group_id` (caught by the catalog int tests: `permission denied
for table datasets` on group moves).
- **The 0009 stamp rewrites `created_by`/`added_by` to auth.uid() even in
  fixtures** — a project inserted with another user's `created_by` lands
  owned by the ACTING identity (and the birth trigger mints THEIR owner
  membership). Fixtures that need per-user ownership must insert each
  user's rows WHILE THEY ACT (see pg-visibility.int.test.ts seedClosure).
- **Int-test fixture reads must respect the fixture's own RLS** — a
  members-only foreign dataset is invisible to the fixture's other user
  (read its rung through its creator), and the creator reads their own
  locked dataset regardless of the share's rung (min(closure) assertions
  belong to a lens user who is neither creator nor member).
- **Int tests share ONE session and one open transaction — a mid-test
  `rollback()` destroys the fixture.** Role switches (asUser/asAnon) run
  the scenario inside one transaction; never roll back between rungs.
- oxfmt reflows TS/SQL-adjacent markdown alike — run the formatter on new
  files before the gate (same as the 0019-lessons note).

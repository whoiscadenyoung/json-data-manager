---
name: project-catalog-0019-lessons
description: #256/0019 gotchas — draft-scoping the project arm INSIDE the gate, partial-apply tail repair, untracked-file fmt noise, the dev-server stash/routeTree race
metadata:
  type: project
---

2026-11-06, #256 (0019_project_catalog, PR #264, ADR 0018). Four facts,
each caught live:

- **A visibility-widening arm in `can_view_dataset`/`can_edit_dataset` must
  carry its lifecycle gate INSIDE the datasets WHERE, not in the helper.**
  The owned-draft helpers (`project_holds_owned_draft[_editable]`) cannot
  read the datasets row (they are the datasets policies' helpers — a
  datasets read inside would re-enter the same policy), so an unscoped arm
  widened PUBLISHED `author` rows to project members too. The int test
  ("published 'author' owned stays creator-only") caught it; the fix is
  `or (d.lifecycle = 'draft' and public.project_holds_owned_draft(...))`
  in the gate itself. Any future arm (relations, [project 6]'s ladder)
  needs the same in-gate scoping.

- **The 0018-lessons partial-apply tail repair works verbatim**: 0019 was
  applied to the live stack, then edited (draft-scoping fix); re-running
  the whole file died on `column "role" already exists`, and the repair was
  slicing the file from the `create or replace function` section onward and
  applying just that tail. Fresh DBs are unaffected (the migration runner
  sorts by name and applies once).

- **The formatter (oxfmt) formats markdown repo-wide and its list-item
  reflow is flush-left** — hand-written docs with two-space continuation
  lines under list items fail `fmt:check`. `docs/memory/project-
membership-0018-lessons.md` landed on main red (direct docs commit
  bypassed CI); PR #264 had to carry its repair. Run `bun run fmt:check`
  BEFORE committing docs.

- **A running dev server regenerates `app/src/routeTree.gen.ts` during
  stash/lint** — `git stash` + a gate run + `git stash pop` fails with
  "local changes would be overwritten" (twice in one session), and a
  lint/type-check racing a half-written route tree can phantom-error.
  Before any stash/gate dance: `git checkout -- app/src/routeTree.gen.ts`
  first, or stop the dev server; and after a failed pop, CHECK `git stash
list` before re-doing work (a silent failed pop left the whole session's
  work in the stash once).

Related: [[project-membership-0018-lessons]] (policy recursion shapes the
in-gate scoping rule above), [[merge-commit-staging-gotcha]] (gates bare),
[[rewrite-drift-rewrite-from-disk]].

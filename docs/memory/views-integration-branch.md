---
name: views-integration-branch
description: 2026-11-10 integration/views merge of the Views PR stack — what conflicted, the seams fixed, how the walkthrough stack was seeded
metadata:
  type: project
---

`integration/views` = #319 tip + #317 + #316 + #311 + main (#315). Conflicts were
all additive (pg-view-page header: refresh picker next to Duplicate; MEMORY.md
lines; views store imports). `prunedInputs` is #313's `pruneInputs`; #316's
`sqlReadsTable` stays for its scratch table list.

- Scratch guard now calls `analyzeSqlStep(query, aliases)`; its VIEW-only
  output-column errors (unnamed/duplicate/`*` over unknown) are ignored for
  scratch runs, Save as view still reports them.
- The projects/project_artifacts stamp triggers set the owner from
  `auth.uid()`: an admin-session insert leaves it null (create as the user in
  a transaction). The wire client returns jsonb as TEXT: parse in test rpc shims.
- A store mock in a view-page test must carry every store export the page
  reads (`refreshQueueQueryOptions`, `setViewRefreshMode`).
- Walkthrough data: `scripts/seed-views-walkthrough.sql` (design §5 datasets
  in a "Views walkthrough" project). An existing compose volume needs
  `create role jdm_server login password <POSTGRES_PASSWORD>` BEFORE 0027 so
  it is granted `view_runner`; back up with `pg_dump -Fc` first (0028 drops
  `derived_datasets`).
- Never run `vitest` over `src/lib` in `app/` with a live compose db up: the
  int suites default to :54322 and run against it.

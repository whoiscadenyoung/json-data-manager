# Views verification and next issues — handoff (start here)

Date: 2026-11-11 · Umbrella: #298 · Previous handoff:
[`views-handoff.md`](views-handoff.md) · Design:
[`views-design.md`](views-design.md) · Decision:
[ADR 0028](decisions/0028-views.md)

## Progress (2026-11-11, second session) — read this first

This handoff has been worked through. Status:

- **§3 browser checklist: done**, recorded on #298 (comment 6789267939):
  12 passed outright, 7 and 8 passed after fixes, 13 is partial (no
  dataset-delete UI → #329), 15 confirmed the published-map gap (#330; and
  #328, an app over a never-versioned view freezes an empty layer).
- **Fixes merged:** #323 (live view ids persisted as a Set → "Dataset Not
  Found"), #324 (a view's fields as table columns), #325 (live view export
  runs once first), #326 (auto refresh shows without a reload), #327 (entry
  geometry read selected a missing column → 400).
- **§4 follow-ups filed:** #330–#337 (#337 = required checks on `main`, the
  owner's call; no settings changed). Polish from the walkthrough: #338.
- **§5:** #290 closed. #291 merged (#339: `@caden/data-core/currency` +
  import Suggestions card). #292 merged (#340: Structure-tab "Currency
  columns", migration 0031 `rewrite_entry_field`, `x-currency` hint). #293 →
  PR #341 (Structure-tab "Make points from coordinates", migration 0032
  `points_from_coordinates`). #294 → PR #343 (catalog relation badges + map
  layer indicators); related-set grouping split out as #342.
- **Next:** merge #341/#343 when green, close #298, then the GIS backlog
  (#158; #161 re-scoped to a spatial-join view step).
- Local compose db: migrations 0031 and 0032 are applied; the walkthrough
  project gained test datasets ("Grants sample (291)", "Awards as text
  (292)", "Sites table (293)"), a map with three layers, a published link app
  and a States→Deployments key relation.

## Where things stood at the start

The whole Views initiative (#299–#307) is merged on `main` via #320. CI, the
local gate and one browser walkthrough passed before the merge. The
walkthrough covered:

- creating a view;
- a join with diagnostics and "Add to key map";
- summarize count;
- Save, then a run through the server runner;
- the lineage graph;
- a scratch query over the view.

Everything else is **merged but not yet checked in a browser**. This handoff
has two jobs, in order:

1. Run the browser checks below. Fix small breakages directly, and file
   issues for anything larger.
2. File the known follow-ups, then work the next issues (§4).

## 1. Ground rules

- Read `AGENTS.md`, `docs/memory/MEMORY.md` and every
  `docs/memory/views-*.md` first.
- **Commits** go through the `/commit` skill. Use bun, not node.
- **One PR per fix or issue**, branched from `main`. The owner has OK'd
  merging PRs once CI is green.
- **CI policy:** PR pushes run fast checks only. Dispatch the full gate once
  per PR when it's ready: `gh workflow run ci.yml --ref <branch>`. The local
  zero-minute equivalent is `scripts/local-gate.sh`.
- **Int tests** need the dedicated CI-parity db, never the live compose db
  (`docs/memory/int-test-db-split-ri-teardown.md`).
- **Workflow file pushes:** pushing changes to `.github/workflows/` over
  HTTPS fails. Push through the SSH alias
  (`docs/memory/gh-push-workflow-scope.md`).

## 2. Environment

- **Local stack:** the compose stack runs on kong `:8000` and db `:54322`.
  - Migrations are applied through 0030.
  - The `jdm_server` login role exists.
  - A pre-Views backup is in `backups/app-pre-views-20261110.dump`.
- **Dev app:** run it from the main checkout's `app/`. See
  `docs/memory/local-dev-verification.md` and `workspace-run-gotchas`.
  - `app/.env.local` needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
    `DATABASE_URL` and `JWT_SECRET`. `views-server-runner.md` says how they
    are wired.
  - Copy them from the integration worktree's `app/.env.local` if it still
    exists (`.claude/worktrees/agent-a59ade1a17a41b5db/app/.env.local`).
    Otherwise rebuild them from the repo-root `.env`.
  - A dev server may still be running on `:3000` from that worktree. Stop it
    and run from `main`.
  - Auto refresh only drains while the app server runs with `DATABASE_URL`
    set.
- **Login:** `demo@jdm.test`. The password is in the gitignored
  `docs/local-test-accounts.md`.
- **Test project:** "Views walkthrough", id
  `25821b70-8db3-4099-bdbb-29d3d75057cd`.
  - It holds four datasets: States, Deployments, Deployment agencies and
    Links. The Links data includes `"  kansas "`, `MISSOURI` and an
    unmatched `Narnia`.
  - It also has one view, "States enriched" (a join to Deployments with
    summarize count → `deployments`).
  - To recreate the project, run `scripts/seed-views-walkthrough.sql`; usage
    is in its header.
- **Browser:** use the in-app browser. Prefer `read_page`/`find` over
  screenshots. Take a screenshot as proof for each check.

## 3. Browser checklist

Work top to bottom. For each item, record pass or fail in a PR comment or the
#298 umbrella. On a fail, fix it (small) or file an issue (larger), then move
on.

### Advanced steps (#302)

1. **Design §5 end to end:** on "States enriched" (or a fresh view over
   States), follow the click steps in `docs/memory/views-editor-and-derived-retire.md`.
   1. Add a deployments join with a nested step: "Add steps to this input",
      join Deployment agencies, and summarize count as `agencyCount`.
   2. On the outer join, summarize: count as `deployments` (empty → 0), and
      `topBy(name by agencyCount, highest)` as `mostCollaboration`.
   3. Add a links join with "Ignore case" and "Spread into columns" by
      `type`/`url`. Use "Add proposed columns" and rename them
      `docsLink`/`benefitsLink`.
   4. Save and Refresh now.

   **Expect:**
   - Kansas shows `deployments 3`, a `mostCollaboration` value and a
     `docsLink`. Iowa shows `deployments 0` and no links.
   - Diagnostics list `Narnia` as unmatched.
   - A nested step shows its own counts.

2. **Calculate step:** a typo shows a positioned error underline. Field and
   function autocomplete pop up, and a valid expression adds the field.
3. **SQL step:** `select * from prev` previews. `delete from prev` and an
   undeclared table both show an error.

### Output and exports (#303), which also closes #290

4. **Output fields:** rename a key. "Renamed: a → b" shows. A key like `1st`
   or `has space` warns. Then hide a field, reorder it, Save and Refresh.
5. **Export profiles:** create a GeoJSON profile (keys, omit empty) and
   export. The Kansas feature has exactly the visible keys with no nulls, and
   the hidden field is absent. Repeat with "keep" (nulls present) and with
   "labels" (label property names).
6. **Map:**
   - Create a map in the project and add "States enriched" as a layer.
   - Clicking a state shows a popup with the view's labels in output order.
   - "Popup fields…" overrides the popup, and "Reset to from view" restores
     it.
   - Tile/loading pills clear (the #315 fix).

### Refresh modes (#305)

7. **Auto:**
   1. Set refresh to Auto.
   2. Edit a Deployments row's `stateId`, e.g. move one from KS to IA.
   3. Within about 60–75 s, without pressing anything, the view shows a new
      run with updated counts.
   4. "Next refresh queued" appears in between.
8. **Live:** set refresh to Live.
   - The table computes on read; an input edit shows immediately.
   - The map layer loads through the row path.
   - Export still produces a file.
   - The "Computed on read" tag is shown.

### Reuse (#307)

9. **Duplicate:**
   - Duplicate the view, remapping States to another dataset that lacks a
     used field. Per-step missing-field errors show and Create is blocked.
   - A compatible remap creates a copy in Manual mode.
10. **Extract to view:** on the deployments join's nested steps, Extract to
    view.
    - A new view exists and has rows.
    - The original's preview is unchanged.
11. **Chaining and cycles:** make view A read view B, then try to make B read
    A. The Save toast reads `"A" already reads this view…`.

### Scratch, guards and graphs (#306, #301, #304)

12. **Scratch query:**
    - "Save as view" of a two-table join creates a view that runs.
    - `select set_config('a','b',false)` is refused.
    - A deliberately slow query hits the timeout message.
13. **Guards:**
    - View rows are read-only in the dataset table, with a reason.
    - Deleting States while a view reads it shows the dependent views.
14. **Graphs:**
    - The Lineage page shows the new views, maps and layers.
    - The view page's step graph (if embedded) matches the step list.
15. **Published map, a known gap:** publish the map and open it anonymously.
    Popups show all properties, not the view labels. Confirm, and keep the
    follow-up below.

## 4. Follow-ups to file (as issues, under umbrella #298)

- Published maps don't use view labels: anonymous viewers can't read
  `view_definition`. Needs a world-readable output copy or a definer read.
- Live views:
  - map popups have no entry details (`live:<row_id>` ids);
  - there's no bbox/fit-to-bounds;
  - truncation (20k cap) isn't surfaced in the UI;
  - each search or sort re-fetches.
- A `first`/`last` join without `orderBy` can pick a different row after
  Extract. Warn or require `orderBy` in the UI.
- Cleanup:
  - CHECKs on `publish_bundle_members.kind` and
    `consumer_references.consumer_kind` still allow `'derived'`;
  - derived re-key helpers remain in `map-layers.ts`;
  - archived `app/convex/**` derived code.
- Nested-step previews show counts but not rows (would need a compiler
  option).
- The Calculate form's result type is often "depends on the data", because
  input metadata lacks field types.
- The tile worker can't recover from a hard OOM crash, so the queue stays
  stuck (noted in #315).
- Make the fast checks required on `main` (branch protection), so "merge when
  green" can't merge early. **This is the owner's call**; mention it, don't
  change settings.

## 5. Next issues

1. **#290 (remedies 4):** close it once checks 4–5 pass. Its requirements
   are draft inputs, title-based names and visible renames.
2. **Remedies 5–8.** Each issue has a "Views update" comment saying what
   changed. Recommended order:
   - **#291:** import-time coordinate and currency detection. The shared
     detection utilities feed #292 and #293.
   - **#292:** currency typing. Store numbers with a `format: currency`
     hint, so view `sum`/`avg` work.
   - **#293:** spreadsheet → geospatial conversion, as a dataset-level
     conversion (not a view step).
   - **#294:** relation indicators. Reuse the relation data that the lineage
     graph (#304) already reads.
3. Then the GIS backlog: #158 umbrella; #161 is re-scoped to a Postgres
   spatial-join step kind on the views compiler.

When everything in §3 passes and the follow-ups are filed, close umbrella
#298 with a summary comment.

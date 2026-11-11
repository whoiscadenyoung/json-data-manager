# Views — handoff (start here)

Date: 2026-11-10 · Umbrella: #298 · Sub-issues: #299–#307 ·
Decision: [ADR 0028](decisions/0028-views.md) · Design:
[`views-design.md`](views-design.md)

## What this is

Derived datasets become **Views**: datasets whose rows come from a saved
list of steps (join, summarize, spread/pivot, filter, calculate, SQL).
The steps compile to Postgres SQL, and each run saves its output into
real rows. The work happens in one editor, with a lineage graph. The
design doc is the reference; this file says how to pick up the work.

## Ground rules (owner decisions; don't relitigate)

- **Green and disposable.** No backward compatibility and no migration of
  stored derived specs. Drop tables and code freely when an issue says to
  retire them.
- **Flat output by default.** Arrays only when the user picks `list`;
  ArcGIS needs flat feature properties.
- **One SQL engine: Postgres**, through a server function acting as the
  user (RLS applies). Scratch queries run there too; DuckDB-WASM is
  retired. Users write raw SQL only in the scratch pad and `sql` steps.
- **No templates.** Reuse means Duplicate, chaining and Extract to view.
- **Labels live in the view and the layer**; keeping or omitting empty
  fields is the user's choice.
- **Name-based joins are first-class**: users often don't have codes, so
  key normalization plus a manual key map is required.
- **Relations stay** (for related records without a joined field) until
  the open question in design §12 is answered.

## Order of work

| #     | Issue                                                  | After | Notes                                                        |
| ----- | ------------------------------------------------------ | ----- | ------------------------------------------------------------ |
| 1     | #299 step format + SQL compiler                        | —     | Pure package work; golden SQL tests                          |
| 2     | #300 schema + runner + previews + staleness            | 1     | Record runner location and the visibility rule               |
| 3     | #301 editor v1 + retire derived datasets               | 2     | First user-visible PR; removes the legacy system             |
| 4     | #302 advanced steps (spread, sub-pipelines, calc, SQL) | 3     | Makes the §5 walkthrough fixture pass                        |
| 5     | #303 labels + export profiles + tooltip defaults       | 3     | Shares the view editor with #302; coordinate or run serially |
| 6     | #304 React Flow graphs                                 | 3     | Client-only rendering (SSR gotcha)                           |
| 7     | #305 auto + live refresh                               | 3     |                                                              |
| 8     | #306 server Scratch query + retire Analysis/DuckDB     | 3     |                                                              |
| 9     | #307 Duplicate / remap / Extract                       | 4     |                                                              |
| Later | #161 re-scoped: spatial steps on the views compiler    | 4     | Not filed as a views issue yet                               |

1 → 2 → 3 is strictly serial. After #301, issues 6, 7 and 8 can run in
parallel sessions. Issues 4 and 5 both edit the view editor, so run them
one after the other or split files carefully.

## Per-session checklist

1. Read `AGENTS.md`, `docs/memory/MEMORY.md` (and entries the issue
   touches), ADR 0028, and the design-doc sections the issue names.
2. Branch from `main` (`feat/views-<n>-<slug>`). Commit with the
   `/commit` skill. Use bun, not node.
3. Int tests run against a **dedicated** CI-parity db, never the live
   compose db (`docs/memory/int-test-db-split-ri-teardown.md`).
   `scripts/local-gate.sh` is the full zero-minute gate.
4. CI: PR pushes run fast checks only; dispatch the full gate once when
   the PR is ready (`gh workflow run ci.yml --ref <branch>`).
5. Record each decision the issue lists, in the design doc or a new ADR
   if it is architecture-level. Add a `docs/memory/` entry for gotchas.
6. When an issue merges, update this file's table (mark it merged, with
   its PR) and tick the umbrella.

## Status

**All merged 2026-11-11** via #320 (merge commit `c01407e`), the integration of the whole stack. The stacked PRs #309–#319 were closed in favor of #320, with their commits included unchanged.

| Issue | PR   | Merged via |
| ----- | ---- | ---------- |
| #299  | #309 | #320       |
| #300  | #310 | #320       |
| #301  | #314 | #320       |
| #302  | #313 | #320       |
| #303  | #318 | #320       |
| #304  | #311 | #320       |
| #305  | #317 | #320       |
| #306  | #316 | #320       |
| #307  | #319 | #320       |

Verified before merge: full CI (run 42962411802), the local gate, and a browser walkthrough of join + summarize, run, lineage and scratch query.

Not yet verified in a browser:

- advanced steps (spread, sub-pipelines, calculate, sql)
- export profiles and popup labels
- auto/live refresh
- Duplicate and Extract
- a view on a map

## Follow-ups (not filed yet)

- Published maps don't pick up view labels, because anonymous viewers can't read `view_definition`.
- Live views: popups have no entry details, there's no fit-to-bounds, and truncation isn't surfaced in the UI.
- `first`/`last` joins without `orderBy` can pick a different row after Extract.
- CHECKs on `publish_bundle_members.kind` and `consumer_references.consumer_kind` still allow `'derived'`; derived helpers remain in `map-layers.ts` and the archived `app/convex/**`.
- Nested-step previews show counts only (no rows).
- #290 can close once renames are checked in a browser.

## Related, outside the train

- **Remedies 4–8 (#290–#294) are deferred until after Views, not
  dropped.** Each has a "Views update" comment saying what changes.
  - #290: its backfill half no longer applies. Its live requirements
    (draft inputs, title-based names, visible renames) are acceptance
    criteria on #299, #300, #301 and #303. Close it once #303 is verified.
  - #291–#294 (import detection, currency, spreadsheet → geospatial,
    relation indicators) are still wanted after Views.
- #280, #282 and #284 were addressed by remedies 1–3 (PRs #295–#297) but
  are still open; close them if their remaining scope is covered.

# Remedies follow-up handoff — the grant-data test pass remainder (2026-11-10)

Where the #273 test-pass work stands and how to finish it. Companion to
`docs/local-test-accounts.md` (gitignored — credentials) and the CI policy in
`.github/workflows/ci.yml`'s header.

## Where things stand

- **PR #285** (`fixes/testing-remedies`): the eight bounded fixes (#272 #274
  #275 #276 #278 + bounded parts of #281 #282 #284). Fast checks green
  (~6 min), local full gate green (1219/1219 on a CI-parity db), in-browser
  verified against the grant project. Awaiting merge; merging runs the full
  gate on main automatically.
- **Merged 2026-11-09**: #273 (project workspace shell, `d86607a`) + its
  perf-test repairs (`e854b51` bulk teardown, `e5ae15a` phase marks + 240 s
  budget) + the CI cost split (`8d90ad2`).

## CI policy (user decision, 2026-11-09 — don't relitigate)

Actions minutes are budget-limited. PR pushes run ONLY fast checks + store
(~7 min total); the full gate runs on `workflow_dispatch` (once, when a PR is
ready: `gh workflow run ci.yml --ref <branch>`) and main pushes. Local
equivalent, zero minutes: `scripts/local-gate.sh` — boots a CI-parity
throwaway stack (bare supabase/postgres + storage-api) and mirrors the full
job step-for-step.

Two rules the hard way earned:

1. **Int tests need a DEDICATED db.** Against the live compose db the
   count/closure assertions inflate with real app data (~9 phantom failures;
   `expected 0 … got 40016`). The compose override publishes the db on
   `127.0.0.1:54322` for quick single-file runs only. Full recipe:
   `docs/memory/int-test-db-split-ri-teardown.md`.
2. **storage-api must be healthy BEFORE migrations apply** (boot-order trap,
   #234/#248): otherwise 0004/0006's storage sections skip silently and the
   storage int tests fail. Wait for `:5001/status`, then apply.

## Environment notes (this stack)

- Test credentials: `docs/local-test-accounts.md` (gitignored). The grant
  project's owner is `reviewer@jdm.test` / `reviewer-password-1` (reset
  2026-11-09 — the old password was unrecorded).
- Kong exit-137'd once on boot; `docker start jdm-kong` fixes it. Kong's
  `/status` 503s while the `jdm-app` compose container is off — harmless in
  dev (vite serves the app locally).
- Local row-path loads of the big polygon datasets finish in ~2.5–4 s on the
  M-series — **the #284 freeze does not reproduce locally**; perf work needs
  CI-parity or a CPU-throttled container to observe.
- Data facts: none of the four big polygon datasets has a built tile archive
  (`map_tile_archive_built_version` NULL, cache versions 15–19) — they ride
  the row path. One empty duplicate import of FY23 Planning/Demo (0
  features) exists and is deletable.
- Stored joins created before #285 keep UUID-prefixed enrichment columns;
  re-create a join from its relation to get title namespacing.

## The remaining work, in recommended order

Each item: what exists (landed in #285 or earlier), what remains, and the
shape of done. Issues #277/#279/#280/#283 are whole-issue features.

1. **#284-b — row path off the main thread** (the actual freeze; first
   because it blocks real use of the big maps). Worker or chunked
   parse/build of GeoJSON (`pg-geometries-loader` fans per-dataset pagers;
   the parse currently blocks the main thread); investigate why tile archives
   never built for the four big datasets (#183/#184 threshold interplay —
   `maxGeometryRowBytes` 0.7–3.3 MB/row); consider read-time simplification
   (stored geometry is 6 dp — far more than national-scale views need).
   Done = Planning grants map stays responsive throughout on a throttled
   environment, and archives either build or have a documented reason not to.
2. **#282-b — non-lossy 1-N join semantics.** Decide the output shape first
   (one row per match = row explosion; aggregate = count+first fields; array
   column): it changes what preview, export, app widgets and popups all see.
   Engine work lands in `@caden/data-core` `lookup.ts` (the duplicate-count
   diagnostic from #285 is the visibility half). Done = a 1-N relation joined
   via "Join into a table" loses nothing, and the stats say which policy ran.
3. **#280 — join outputs belong to the project + a derived route.** The
   relation's "Join into a table" mints an OWNED derived artifact (same
   posture as an owned draft dataset) and the catalog renders a Derived
   section whose rows open `/projects/$projectId/derived/$id` — the joined
   table with its match stats. Today the output lives only in the global
   registry and must be attached by hand as a Linked reference.
4. **#281-b — old joins + aliases.** Decide: backfill stored specs'
   namespaces (a registry migration) vs re-save-in-place; plus user-editable
   column aliases for brought-in fields.
5. **#274-b — import-time suggestions.** Detect coordinate columns and
   currency-shaped values during import; offer typing/conversion in the flow
   (pairs with #277/#279 below; shared detection utilities).
6. **#279 — currency typing.** Shared coercion util (symbols, thousands
   separators, parenthesized negatives, whitespace), per-column confirmation
   in the schema editor (never silent), `format: currency` display hint so
   the Number widget can sum `Federal_Funding_Amount`-shaped fields.
7. **#277 — spreadsheet → geospatial conversion.** Port the Convex-era
   `GeospatialConversionPanel` to the PG store (reuse
   `detectCoordinateColumns`); write Point geometry rows for rows with valid
   coordinates, keep coordinate-less rows as plain entries; offer on existing
   tables and at import time.
8. **#283 — relation indicators + grouping.** Catalog relation badges on
   dataset rows; layers-panel indicators ("Related to FY23 IG Project
   Corridors via UEI") and an optional related-set grouping; build on the
   existing layer groups.

## Decisions to record (ADR-worthy, in the order they'll be hit)

- 1-N join output shape (#282-b) — the biggest one; every consumer inherits
  it.
- Derived-dataset project ownership (#280) — owned artifact vs linked
  reference at creation time.
- Row-path parse strategy (#284-b) — worker vs chunked main-thread vs
  simplify-at-read.

## Issue filing

The split halves above are documented HERE but not yet filed as GitHub
issues — the original #272–#284 stay open per their "Partially addresses"
references. Filing an umbrella + ordered sub-issues (per the usual train
convention) is the natural next step; each item above is already
sub-issue-shaped.

## Verification recipes that worked this pass

- **Browser**: sign in as `reviewer@jdm.test` (see
  `docs/local-test-accounts.md`). Grant project
  `b5adaaaa-0a3e-40f5-910b-a2da8136ba16`; FY22 IG Awards `583ff017-…`
  (publish-error repro — still fails by design on the 0009 oversized-geometry
  limitation); FY23 corridors `a5fe9e17-…` (line rendering); Planning map
  `151dea15-…` (loading states). The publish RPC's rejection text is the
  honest expected state until oversized-geometry freezing gets an answer.
- **Gates**: `scripts/local-gate.sh` (full, zero minutes); `bun run fmt:check`
  - `bun run lint` + per-package typecheck/test for quick passes; single-file
    int runs against a DEDICATED db via `SUPABASE_DB_URL`.
- **Perf test**: the phase marks + 240 s budget in
  `pg-relations.int.test.ts` stay — the 20k SEED is the CI variance cliff
  (144 s observed); don't remove the marks.

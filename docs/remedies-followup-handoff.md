# Remedies follow-up handoff — the grant-data test pass remainder (2026-11-10)

Where the #273 test-pass work stands and how to finish it. Companion to
`docs/local-test-accounts.md` (gitignored — credentials) and the CI policy in
`.github/workflows/ci.yml`'s header.

## Where things stand

- **Merged 2026-11-10**: PR #285 (`088173d`) — the eight bounded fixes
  (#272 #274 #275 #276 #278 + bounded parts of #281 #282 #284).
- **[remedies 1] (#287) MERGED 2026-11-10** (PR #295, main @ `c828a16`,
  ADR 0025): the row-path parse moved into a web worker
  (`pg-geometry-rows.worker.ts` + `-client.ts`; rows cross as parsed
  geometry via `geometryResolved`), the build worker's fetch is
  take-sized (`geometryTakeRowsFor`), and the tile pipeline got a
  drafts-inclusive feed (`tileWatchSummariesQueryOptions`). Verified
  live on the grant stack: the Planning map loads responsively with the
  pill throughout, and ALL FOUR big polygon datasets now have installed
  archives and render via PMTiles (built_v = cache_v for
  0093bbbd/7773e857/c23e38aa/199abd77). CI full gate green on dispatch;
  the one CI-only fix (cb73999) was the stage-3 `#/env` mock in the new
  test (bun auto-loads .env.local locally, CI doesn't).
- **Why the archives never built — three stacked causes**, found live
  2026-11-10 (all fixed by #287):
  1. `install_tile_archive` demanded the bucket-QUALIFIED path
     (`tile-archives/<id>/…`) while uploads/storage/reads all use the
     bucket-RELATIVE convention — every install raised; the #184 backoff
     plateau retried forever, leaking an orphan object per attempt
     (248 objects ≈ 2.1 GB when swept 2026-11-10). Fixed by migration 0026.
  2. The tile manager's feed (`listSummaries`) is published-only, and the
     four big datasets are `lifecycle='draft'` (#276 posture) — they were
     never scheduled at all. Fixed by `tileWatchSummariesQueryOptions`
     (RLS-scoped, no lifecycle gate) + `usePgTileDatasetSummaries`.
  3. The row path itself froze the main thread (ADR 0025's worker
     offload). Also verified in isolation: FY22's 450 features build a
     18.8 MB archive in ~34 s — the build math was never the problem.
     Residual: `bench-20k-points` still shows built_v NULL (its next backoff
     attempt should install under 0026; a benchmark dataset, not tracked).
- **Train filed 2026-11-10**: umbrella #286 + #287–#294 (ordered
  sub-issues for the remainder below), mapped onto #272–#284.
- **[remedies 2] (#288) MERGED 2026-11-10** (PR #296, main @ `60b868b`,
  ADR 0026): `onDuplicateKey: "collect"` — 1-N joins keep EVERY match as
  per-field arrays, row count unchanged; new joins default to collect
  (editor + relation mint), stored specs keep "first"; the stats line
  says which policy ran (`collectedLookupRows`). Verified live: the FY23
  IG Awards + Corridors collect join collects 22 corridors onto one
  award (ZEL3HB6H7B24) — the same 133 rows the legacy join dropped now
  read "collected into arrays (1-N)". The verification pass also
  re-confirmed the #280 gap (the minted derived artifact lands in the
  global registry only, invisible in the project catalog).
- **[remedies 3] (#289) MERGED 2026-11-10** (PR #297, main @ `39fd681`,
  ADR 0027): the relation's one-click join mints the registry row AND an
  OWNED catalog membership; `/projects/$projectId/derived/$derivedId`
  renders the joined table with its match stats; the catalog's Derived
  cards, the Analysis cards, and the Transform tab's "Open" links all
  reach the route. Bundle press unchanged (derived rows re-execute;
  sources ride the bundle). Verified live end-to-end on the grant stack.
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

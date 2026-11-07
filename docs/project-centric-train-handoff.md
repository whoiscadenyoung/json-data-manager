# Project-centric experience train — agent handoff

Written 2026-11-05, main @ 55a3fa7. Updated 2026-11-05 after [project 1]
(#255, PR #263). Updated 2026-11-06 after [project 2] (#256, PR #264),
[project 3] (#257, PR #265), [project 4] (#258, PR #266), [project 5]
(#259, PR #267), [project 6] (#260, PR #268), and [project 7]:
**#261 DONE (PR #269, main @ 1e1f0a8) — next work is #262 (the closeout).**

## What this train is

Projects become the primary working context (SaaS posture): inside a project
users manage a catalog (create/import/add-by-reference), relate/join
datasets, build maps from styled layers, and publish apps. The
datasets/maps/apps/collections tabs become exploratory views. Train:
umbrella **#254** + ordered sub-issues **#255 → #262**, one PR per issue, in
order. Approved design: `docs/project-centric-experience-design.md` (§7 =
resolved decisions D1–D7; §5 = the scenario that is the train's exit test).

## Read first, in order

1. `docs/memory/MEMORY.md` + the project-centric entry (AGENTS.md rule).
2. `docs/project-centric-experience-design.md` — the authority. Don't
   relitigate D1–D7 (one-line: datasets global + membership · maps
   project-owned, /maps = explorer · relations catalog-level · full
   visibility ladder `members|signed-in|link|public` · collections standalone
   AND bundle-minted · per-artifact publish + bundle closure · app map
   widgets reference stored maps).
3. The exact issue you're executing — its **acceptance criteria are the
   contract**. Umbrella #254 holds the order + the parked/out-of-scope list.
4. Only for #255–#257: predecessor spec `docs/project-workspace-design.md`
   and the `feat/project-workspace` branch. **Reference only — never merge**
   (Convex-era backend; the PG machinery differs).

## Ground rules

- **No back-compat or adoption steps anywhere.** App not in production, PG
  data disposable — every phase ships its final shape. Breaking migrations
  fine (next migration number: 0021+; ADRs: 0020+).
- Branch off fresh `main` (`git fetch --prune` first). One PR per issue;
  merge with the standard flow (see `docs/memory/pr-merge-sync-flow.md`).
- Gates before every PR, run **bare** (pipelines mask exit codes): app tests,
  oxlint, `tsc`, and `oxfmt` on touched files (the formatter is oxfmt).
  Tests whose imports reach `env.ts` need `vi.mock("#/env")`.
- Commit only via the `/commit` skill; stage **explicit file paths** (the
  directory-add gotcha ate work twice before).
- DB-level tests follow the existing wire-client int-test pattern; every new
  migration must apply on a fresh DB (migrations run sorted by name).

## Environment

- Backend: self-hosted Supabase (kong, one origin :8000), PostGIS on (0001).
  Stack recipes: `docs/memory/self-hosting-stack-2026-11-05.md`; migrations in
  `supabase/migrations/`. Realtime publication is 0013 — extend it when a
  phase's tables need presence.
- App: TanStack Start (nitro), `app/src` = core + domain features; PG store
  modules live in `app/src/lib/store/`. Dev picks :3001 if stale :3000 held.

## Per-phase pointers

- **#255 roles** — ✅ DONE (PR #263): `project_members` + role-based RLS
  rewrite of the four project tables, `project_invite_resolve` RPC, realtime
  publication join (REPLICA IDENTITY FULL on project_members), members
  dialog + seat-role badges + viewer gating. ADR 0017. Migration/RLS
  authoring gotchas: `docs/memory/project-membership-0018-lessons.md`.
- **#256 catalog** — ✅ DONE (PR #264, ADR 0018, migration 0019):
  `project_artifacts` role owned|linked + sync_mode manual|auto; linked adds
  pin at head (versionless chains float honestly); owned drafts carry no
  edge; the deferred clause landed DRAFT-SCOPED in the gate (owned drafts
  member-visible/editor-writable; linked drafts share nothing; publishing
  returns a row to the catalog's own rules); in-project create/import
  (`/projects/$projectId/create`) births owned drafts that never auto-
  publish; catalog workspace with provenance chips + sync/revert/float/pin;
  add-existing picker (datasets + derived, D1); add-to-project affordances
  on the browser/detail pages. Kind domain is now `dataset|derived` — map
  memberships + their edges were deleted, and the bundle press lost its map
  legs until [project 3] re-owns maps. RLS authoring gotchas:
  `docs/memory/project-catalog-0019-lessons.md`.
- **#257 layers/maps** — ✅ DONE (PR #265, ADR 0019, migration 0020):
  `layers`/`layer_children`/`layer_versions` (style on the layer row;
  layer_styles/map_layer_overrides retired); maps project-owned ROWS with
  the per-creator backfill — kind `map` did NOT return to memberships
  (correcting this doc's earlier note); the in-project editor at
  `/projects/$projectId/maps/$mapId` (auto-layer, restyle, groups +
  cycle guard, publish/link/clone); /maps = explorer; the workspace's
  Maps view; realtime joined layers/layer_children and RE-ENABLED RLS on
  the recreated map_layers (the DROP-table-takes-the-enablement trap —
  `docs/memory/project-layers-0020-lessons.md`). Rendering stays live;
  frozen-row rendering is [project 5]'s.
- **#258 relations** — ✅ DONE (PR #266, ADR 0020, migration 0021):
  `dataset_relations` catalog-level rows (D3; both ends' own dataset gates
  ARE the RLS — view to read, edit to write, a project seat grants
  nothing); the `dataset_relation_records` bounded runtime RPC (index-
  backed, viewport-scoped, 200/500 cap, page-cut-INNERMOST paging, the
  other side resolves through its membership pin's frozen version); the
  catalog Relations section (declare key/spatial, one-click lookup-join →
  saved derived dataset); the opt-in map runtime in the in-project editor
  (`LayersMap relationRuntime` prop — amber highlight overlay + related-
  records popup section, drill-in on highlighted points; surfaces without
  the prop pay nothing). ALSO FIXED a live main bug: `$projectId.tsx`
  (workspace, no Outlet) masked its children — `/create` and
  `/maps/$mapId` rendered the workspace at their own URLs; now
  `route.tsx` (layout + archive gate) + `index.tsx` (workspace).
  Lessons: `docs/memory/project-relations-0021-lessons.md` (Outlet
  masking, migration-session auth.uid() vs the stamp trigger,
  NULL-vacuous CHECKs, page-cut-in-window paging, fixture
  is_geospatial/bbox flags, in-test ANALYZE churns shared stats).
- **#259 apps** — ✅ DONE (PR #267, ADR 0021, migration 0022):
  `apps.project_id` NOT NULL (per-creator backfill, the 0020 pattern);
  member-wide reads + project-editor writes with the one `example` SELECT
  arm (the 0014 creator gate died; `revision` CAS unchanged); the inline
  `datasetIds` map widget RETIRED — widgets carry `mapId` into stored
  project maps (live render via `StoredMapCanvas` in features/maps; the
  builder's picker lists project maps, create-from-builder persists the
  map row + links + opens the editor); the freeze is an `app_versions`
  chain whose self-contained snapshot (datasetPins + mapSnapshots +
  flattened layerVersions) renders the published viewer from frozen data +
  immutable `version_entries` only (owned draft layers publish first;
  published layers freeze their existing head); /apps = explorer with
  project chips + start-from-here; the workspace's Apps section receives
  its create-app dialog through a ROUTE-LEVEL slot (`CreateAppSlot`) —
  app-builder stays route-wired (ADR 0011/0014), and layer-styles LEFT the
  optional-module lint list (D7). The seed re-owned both examples into a
  "System examples" project and published them (v1 snapshots) — verified
  in-browser as a signed-in NON-MEMBER. Lessons:
  `docs/memory/project-apps-0022-lessons.md` (the artifacts stamp
  overwrites added_by with auth.uid() — claims GUC per row in migration
  loops; version rows carry no kind — infer from dataset/frozenChildren;
  app_versions denial reads as RLS 0-rows; stable onLoaded or the frozen
  loaders OOM-loop).
- **#260 ladder** — ✅ DONE (PR #268, ADR 0022, migration 0023): one
  `visibility members|signed-in|link|public` enum on datasets/layers/maps/
  apps/projects (`published_visibility` and `apps.sharing` are GONE; the
  in-migration mapping: author→members, everyone→signed-in,
  private→members, link→signed-in; the seeded examples project widened to
  `signed-in`). RLS re-issued: the wider arms are PUBLISHED-scoped (draft
  layers/datasets stay member-gated); anon SELECT gates exist NOW on the
  frozen rows only (dataset_versions/version_entries/layer_versions/
  app_versions, gated through SECURITY DEFINER helpers — policy subqueries
  evaluate under the invoking role and would read zero anon rows); live
  tables have no anon policies. The closure engine: `visibility_preflight`
  (read-only diff report — promotions + blockers + effective =
  `min(closure)`) and `visibility_apply` (one transaction, re-walked
  server-side, per-member edit gates, widen-only) over the artifact graph
  app→maps→layers→datasets with foreign pins included. The bundle press
  stamps `publish_bundles.visibility` + per-member `visibility_from/to`
  and applies after the freeze legs. Share UI: the app share dialog runs
  preflight→confirm→apply on widening; the dataset share dialog rides the
  plain column write (leaf artifact); the press dialog picks the rung.
  Lessons: `docs/memory/project-visibility-0023-lessons.md`.
- **#261 anon serving** — ✅ DONE (PR, ADR 0023, migration 0024): the ONE
  public route is `/apps/$appId` (the AuthGate exempts exactly that shape —
  deeper segments stay gated; explorers stay signed-in for [project 8]);
  the anon branch renders the whole view from the head `app_versions`
  snapshot (the live `apps` row and membership reads never run signed-out;
  a null head = the RLS-honest denial card with a sign-in CTA). Tiles ride
  FROZEN-version archives: the publish walk builds each large geospatial
  pin's PMTiles from its own `version_entries` rows via a one-shot worker
  message and stamps `frozen_archive` on the pin; 0024's anon policy grants
  SELECT only on the `frozen-` path convention at link/public — the LIVE
  archives stay anon-closed (the `frozen-` marker is the leak guard). The
  frozen map canvas signs per-pin URLs (anon CAN sign under 0024) and feeds
  `pmtiles://` tile sources; below-threshold pins render rows. Share UX:
  the "this link is live" chip on the published view, per-rung liveness
  notes in the share dialog. Policy matrix: `pg-anon-serving.int.test.ts`
  (closure traversal as anon, min(closure) at anon, the exact-rung matrix,
  the storage leg incl. the live-object control). Verified in-browser with
  bench-20k-points (20k points render anon via 206 range reads on the
  frozen archive; narrowing to members closes serving + the chip; the
  members app shows the denial card). Lessons:
  `docs/memory/project-anon-serving-0024-lessons.md` (pmtiles:// prefix,
  cross-port localhost cookies defeating signed-out tests, the two-stack DB
  split, 63-char policy names, storage-api's NoSuchKey masking).
- **#262 closeout** — run the tourism walkthrough end-to-end in the browser
  (parks project → tourism project reusing pinned data → published app
  opened signed-out). Re-verify every earlier issue's criteria on main,
  then close #254.

## Reporting

Progress + any decision drift in issue comments; durable learnings →
`docs/memory/` (one-fact file + index line per AGENTS.md). Keep the
umbrella's tracking comment current as issues land.

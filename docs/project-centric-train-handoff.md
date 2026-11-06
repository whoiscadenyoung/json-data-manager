# Project-centric experience train — agent handoff

Written 2026-11-05, main @ 55a3fa7. Updated 2026-11-05 after [project 1]
(#255, PR #263). Updated 2026-11-06 after [project 2] (#256, PR #264) and
[project 3]: **#257 DONE (PR #265, main @ 3bc7236) — next work is #258.**

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
- **#258 relations** — `dataset_relations` (key|spatial, catalog-level);
  migrations now 0021+, ADRs 0020+;
  runtime queries GiST-backed, viewport-scoped, hard cap ~200 + "show more".
  Perf lessons: `docs/memory/map-performance-audit-2026-10.md`.
- **#259 apps** — `apps.project_id` NOT NULL; update the two seeded example
  apps in the same migration; keep the `revision` CAS save flow.
- **#260 ladder** — replaces `published_visibility`/`apps.sharing`; closure
  preflight never widens without explicit review; effective access =
  `min(closure)` incl. foreign pinned members blocking wider shares.
- **#261 anon serving** — anon sees ONLY frozen published rows at
  link/public; never drafts, never live tables; no service-role shortcuts.
  SSR facts: `docs/memory/prod-ssr-build-invariants.md`.
- **#262 closeout** — run the tourism walkthrough end-to-end in the browser
  (parks project → tourism project reusing pinned data → published app
  opened signed-out). Re-verify every earlier issue's criteria on main,
  then close #254.

## Reporting

Progress + any decision drift in issue comments; durable learnings →
`docs/memory/` (one-fact file + index line per AGENTS.md). Keep the
umbrella's tracking comment current as issues land.

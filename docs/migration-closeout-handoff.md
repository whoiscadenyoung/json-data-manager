# Migration closeout — handoff for the next session (2026-11-05)

Supersedes [`supabase-handoff-2026-11-05.md`](supabase-handoff-2026-11-05.md)
(kept for the per-stage record). The migration is complete and deployed
locally; this handoff covers exactly one thing: **finishing the closeout —
no new features** — as tracked in the issue train below. When the train is
empty, the app is launch-ready.

## 0. State of the world (updated 2026-11-05, end of the closeout session)

- **main @ 41bbf16+** — the closeout train EXECUTED: #220–#226 and #228–#230
  all merged (PRs #231/#232/#235/#236/#237/#238/#239/#240/#242) and closed.
  #229's re-scope decision filed as
  [#241](https://github.com/whoiscadenyoung/json-data-manager/issues/241)
  (Postgres-era bound sources; #78/#72 closed as superseded). ADR 0016
  status flipped to **deployed** (local restore rehearsal in
  [self-hosting-design.md §10](self-hosting-design.md); the VPS cutover is
  the §11a handoff checklist).
- **CI on main**: the storage-api boot repair is VERIFIED (the rerun got
  past the seam for the first time). CI remains red via `Test (app)`
  flaking across DIFFERENT int-test files per run — **#234** (suspect: the
  JWT-claims GUC interleaving across the shared service DB under runner
  load; retry is not a remedy). Main is effectively red until #234 is
  triaged; merges still gate on the local suite per the working agreement.
- **Launch blockers found by #227's live pass** (all filed, none fixed):
  **#243** prod-image SSR serves ResolveMessage JSON on every route (the
  route-tree chunk pin silently stopped matching — no inlined react copy),
  **#244** Data-tab column sort does not sort, **#245** Compare versions
  flips the page to Dataset Not Found in place. #227's checklist itself is
  the only open train item: its four measurements are recorded (20k import
  4.05 s, cold-open 2.77 s vs 16.5 s, realtime 6 ms/527 ms + UI flip,
  zero-Convex network) with two sub-items unexercised (filter menus, Export
  dialog) pending #243/#244/#245.
- **Remaining work lives in one place**: the closeout issue train,
  umbrella **#219** with ordered sub-issues **#220–#230** (tracking table in
  #219's first comment). Sequence note there: #227's measurements feed
  #228's verdicts; #224's decision constrains one line of #225; #230 (ops)
  can run in parallel with #228–#229. Nothing else is outstanding: #137 is
  a parked do-not-implement record, #82 is reference-only, the two
  load-flaky tests (`convex/versions/consumption.test.ts`,
  `pg-realtime.int.test.ts`) carry a standing do-not-fix directive, and the
  Parquet sidecar stays parked.

## 1. Working agreements (carry over)

- Commits via the `/commit` skill; bun, not node; per-package dists are
  built in CI order (`data-core`, `importers` → `json-cms`,
  `geometry-archive`, `data-export`) before anything resolves them.
- Merges gated on the local gate suite (the ci.yml command set), never on
  waiting for CI. Stacked PRs must be retargeted to main before merging.
- Pushes touching `.github/workflows/` need the SSH host alias
  `github.com-whoiscadenyoung` (the gh token lacks `workflow` scope).
- Verification evidence goes ON the issue (screenshots, timings, devtools
  output); defects found while verifying file NEW issues — don't fix inline.
- fmt:check locally still fails only on the untracked `.zcode/plans/*.md`
  (CI never sees them; leave them untracked).

## 2. Local environment (cleaned 2026-11-05)

- **Primary checkout** (`~/Developer/json-data-manager`, branch `main`):
  the compose self-host stack runs from here — `cp .env.example .env`,
  `deploy/scripts/generate-keys.sh` (already done; `.env` is local-only),
  `docker compose up -d --build`. Currently up on
  **:8000** with migrations applied and a demo user
  (`demo@jdm.test` / `demo-password-1`, dataset "self-host demo" +
  `geometries/<id>/row-0.json`). `docker compose down -v` wipes it.
  Studio: `docker compose --profile studio up -d` → host :54323.
- **CLI stack worktree** (`../jdm-supabase-backend`): re-branched to
  `local/supabase-stack` == origin/main (tracks it; was stuck on the merged
  `feat/supabase-stage-0` whose set is only 0001–0002). `bunx supabase
status -o env` and `supabase db reset` are SAFE from there now — all 14
  migrations present, `config.toml` byte-identical to main. The CLI stack
  keeps ports 54321–54323; the compose stack deliberately uses only :8000
  so they coexist.
- **Parked work, preserved**: `feat/project-workspace` (worktree
  `../jdm-project-workspace`, now pushed to origin) holds ~8+ unmerged
  commits (in-project map editor, five-tab workspace, project-owned maps)
  from 2026-10-08, Convex-era, with uncommitted edits in
  `app/convex/layers.ts` + `app/convex/schema.ts`. Do NOT delete; it needs
  a Postgres-port-or-retire decision that belongs to feature planning, not
  this closeout. The superseded Convex-era `feat/app-builder` branch is
  archived at tag `archive/feat-app-builder`.
- **Branch hygiene** (as of this handoff): remotes are `main` +
  `feat/project-workspace` only; six merged remote branches, two merged
  local branches, and the stale `pr192` tracking ref were deleted.
- Bench fixtures: `/tmp/jdm-ab/` (gen-points.ts, serve.ts, bench-import.ts,
  points20k.geojson); bench user `bench@jdm.test` / `bench-password-1`
  (recreate via the gotrue **admin** API with the service key — signup is
  disabled everywhere).

## 3. What the next session does

1. Fix the three launch blockers — **#243** (prod SSR: restore the
   route-tree chunk pin's inlined react copy or guard it so a pin miss
   fails the build), **#245** (compare-versions state race), **#244**
   (sort wiring) — each verified in the browser per #227's repro.
2. Triage **#234** (CI int-test flake) — likely per-file DB isolation or
   serial int execution; then confirm CI green on main.
3. Finish **#227**'s two unexercised sub-items (filter menus, Export
   dialog) on a healthy stack; close it with the final evidence comment.
4. Close **#219** with a closeout comment (it holds only #227 now), then
   update this handoff — or replace it with the launch announcement. The
   VPS cutover (§11a) can run any time after #243; the local rehearsal
   already proved the backup/restore path.

# Migration closeout — handoff for the next session (2026-11-05)

Supersedes [`supabase-handoff-2026-11-05.md`](supabase-handoff-2026-11-05.md)
(kept for the per-stage record). The migration is complete and deployed
locally; this handoff covers exactly one thing: **finishing the closeout —
no new features** — as tracked in the issue train below. When the train is
empty, the app is launch-ready.

## 0. State of the world

- **main @ `ea1b2c0`** — migration complete (ADR 0015, stages 0–7 +
  app-builder #216/#217), self-hosting stack landed via #218
  ([ADR 0016](decisions/0016-self-hosted-supabase-vps.md),
  [design](self-hosting-design.md)), prod-SSR chunk-cycle fix in
  `app/vite.config.ts`.
- **CI on main**: the pg_cron red (unbroken since 0012 landed) is repaired —
  CI now runs the image-default `postgres` database, the store assert knows
  0012's `sync-chunks` bucket (5 total), and the storage-api boot steps'
  `DATABASE_URL` follows. Verify the run triggered by `ea1b2c0` is green
  first thing; that is the last untested seam of the repair.
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

## 3. Suggested session plan for the next agent

1. Confirm the CI run for `ea1b2c0` is green on main (both jobs).
2. Work the train in order — #220 → #226 are code (small; #225 is one PR,
   #224 needs its decision recorded first), then #227 verification with
   evidence-on-issue, then the #228/#229 decisions, then #230 go-live.
3. #230 ends with the ADR 0016 status line flipped to "deployed" and a
   recorded restore rehearsal.
4. When #219 has no open sub-issues: close it with a closeout comment, and
   update this handoff (or replace it with the launch announcement).

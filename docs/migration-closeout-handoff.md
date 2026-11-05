# Migration closeout — COMPLETE; launch-ready (2026-11-05)

Supersedes [`supabase-handoff-2026-11-05.md`](supabase-handoff-2026-11-05.md)
(kept for the per-stage record). **The closeout train (#219) is empty and
closed** — every sub-issue #220–#230 carries a merged PR or a verdict
comment, the launch blockers are fixed and verified, and the compose
stack on :8000 serves from a current merged-main image. This document is
now the launch-state record; the next action is the VPS cutover.

## 0. Launch state (updated 2026-11-05, closing session)

- **main @ b5155da** — closeout train executed and closed:
  - #220–#226 + #230 merged (PRs #231/#232/#235–#240/#242), #228/#229
    closed with verdicts (#182 umbrella closed, #188 re-targeted to the
    GIS track #158; #78/#72 closed as superseded, Postgres-era successor
    = [#241](https://github.com/whoiscadenyoung/json-data-manager/issues/241)).
  - #227's live checklist fully evidenced (filter menus + Export dialog
    included) and closed.
  - Launch blockers: **#243 FIXED** (PR #246 — prod SSR is
    self-contained: react/react-dom/scheduler stay external and are
    materialized into `.output/server/node_modules` by
    `app/scripts/finalize-ssr-output.ts`, which also FAILS THE BUILD on
    any unresolvable bare external; the vite-service output folds into
    one server chunk, killing the `require_shim` cycle class; the old
    route-tree advancedChunks pin was proven dead code and removed),
    **#245 FIXED** (PR #247 — the PG compare renders the pure
    `VersionCompareView`; the convex `useQuery` throw without a provider
    no longer surfaces through the query boundary as "Dataset Not
    Found"), **#244 resolved works-as-designed** (the sort control is a
    dropdown menu; asc/desc verified riding `?sort=` server-side).
  - **#234 FIXED in two parts** — PR #248 (`fileParallelism: false`,
    ~zero wall-time cost) removed the concurrency suspect, and PR #250
    found + fixed the real root cause: the `ci` job applied migrations
    BEFORE booting storage-api, so on the bare image the 0004/0006
    storage sections silently skipped (no storage schema yet), and
    storage-api then created `storage.objects` with zero policies →
    stable RLS denials whose run-to-run variance was a probe/boot race.
    The ci job now mirrors the store job's boot-first order.
    **CI on main is GREEN end to end** (run 42075309635 @ fd43ff5,
    both jobs success — first fully-green main run since 2026-11-04).
- **Compose stack (:8000)**: rebuilt from merged main, all services
  healthy, `/signin` `/dashboard` `/datasets` verified HTML 200, zero
  ResolveMessage/require_shim errors. Demo user
  (`demo@jdm.test` / `demo-password-1`), dataset "self-host demo".
  Studio: `docker compose --profile studio up -d` → :54323.
  `docker compose down -v` wipes it.
- **Local gates all green** at b5155da (fmt, lint 0 errors, all package
  typechecks + tests, app tests serialized, app build incl. the new
  guard). fmt:check locally still flags only the untracked
  `.zcode/plans/*.md` (CI never sees them).

## 1. The only remaining step: VPS cutover

§11a of [`self-hosting-design.md`](self-hosting-design.md) is the
runbook; the local restore rehearsal (#230) already proved the
backup/restore path. Any time the VPS exists:

1. Follow §11a end to end (docker login ghcr — the image is private).
2. The image to deploy is `ghcr.io/whoiscadenyoung/json-data-manager`
   built from b5155da+ (CI/CD builds it; or build locally).
3. §11a step 9's "sign in" check now works — #243 was the blocker.

## 2. Working agreements (carry over)

- Commits via the `/commit` skill; bun, not node; per-package dists are
  built in CI order (`data-core`, `importers` → `json-cms`,
  `geometry-archive`, `data-export`) before anything resolves them.
- Merges gated on the local gate suite (the ci.yml command set), never
  on waiting for CI. Stacked PRs must be retargeted to main before
  merging.
- Pushes touching `.github/workflows/` need the SSH host alias
  `github.com-whoiscadenyoung` (the gh token lacks `workflow` scope).
- Verification evidence goes ON the issue; defects found while verifying
  file NEW issues — don't fix inline.
- App tests now run with `fileParallelism: false` (vitest.config.ts) —
  don't "optimize" this back to parallel without re-reading #234: the
  int tests share one Postgres service DB per CI job.

## 3. Environment notes (unchanged unless listed)

- **CLI stack worktree** (`../jdm-supabase-backend`, branch
  `local/supabase-stack` == origin/main): `bunx supabase status -o env`
  and `supabase db reset` are safe there; ports 54321–54323 coexist with
  the compose stack (:8000 only). The bench user
  (`bench@jdm.test` / `bench-password-1`) and the 20k fixtures
  (`/tmp/jdm-ab/`) live against that stack — used for the browser
  verification passes.
- **Parked work, preserved**: `feat/project-workspace` (worktree
  `../jdm-project-workspace`, pushed to origin) holds ~8+ unmerged
  Convex-era commits with uncommitted edits. Do NOT delete; a
  Postgres-port-or-retire decision belongs to feature planning. The
  superseded `feat/app-builder` branch is archived at tag
  `archive/feat-app-builder`.
- Local branches cleaned through the closeout: only `main` (plus the
  parked worktree branches above) remains.

## 4. Open strands (all deliberate, none launch-blocking)

- [#241](https://github.com/whoiscadenyoung/json-data-manager/issues/241)
  — Postgres-era bound sources (feature work, future).
- #158 GIS basic-tier track (+ #188 clustering re-targeted there).
- #137 parked do-not-implement record; #82 reference-only.
- Parquet sidecar — parked (analysis layer).

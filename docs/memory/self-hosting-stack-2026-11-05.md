---
name: self-hosting-stack-2026-11-05
description: Self-host compose stack (kong one-origin), the migrations runner recipe, and the production-SSR build findings from the 2026-11-05 hosting initiative
metadata:
  type: project
---

2026-11-05 self-hosting initiative shipped (docs/self-hosting-design.md +
ADR 0016, branch feat/self-hosting): root `docker-compose.yml` + `Dockerfile` +
`deploy/` (kong.yml, migration runner, key gen, backup, postgres init).
Local demo verified end-to-end through kong on :8000 (app 200, gotrue grant,
RLS dataset insert, search_entries RPC, storage upload + signed read, anon
read blocked). Local stack: `cp .env.example .env` + `deploy/scripts/generate-keys.sh` +
`docker compose up -d --build`; `docker compose down -v` wipes the demo data.

Hard-won gotchas, in blast order:

- **CI was RED on main since 0012 landed** (stage 7): both jobs died at
  `create extension pg_cron` — pg_cron may only be created in the db named by
  `cron.database_name` (postmaster context, no ALTER DATABASE workaround;
  GitHub service containers can't pass postgres server args). Fixed by running
  CI against the image-default db name (`POSTGRES_DB: postgres`); the compose
  stack keeps `app` and boots `-c cron.database_name=app` instead. The store
  assert was also stale: 0012 adds the `sync-chunks` bucket (5 buckets total,
  not 0004's four).
- **supabase/postgres image init order**: the service roles are created by the
  image's `migrate.sh`-driven init-scripts, so the password-pinning initdb
  script must sort AFTER it (`deploy/postgres/zz-supabase-roles.sh`; `01-`
  ran against zero roles). The image's default CMD is `postgres -D
/etc/postgresql` — overriding CMD drops `listen_addresses=*` (postgres binds
  loopback only); keep the `-D` flag when adding `-c` flags.
- **The migrations runner polls `to_regclass('storage.objects')` via psql**,
  not HTTP — the nix bash in the postgres image has no `/dev/tcp`, and the
  storage tables are exactly the 0004 readiness signal. Bookkeeping in
  `supabase_migrations.schema_migrations` makes `compose up` idempotent.
- **kong config** (`deploy/kong.yml`) is the CLI-generation shape: NO key-auth
  (downstream JWT verification + RLS is the gate; signed-URL storage reads
  need no apikey), `_format_version "1.1"`, request-transformer carries
  apikey→Authorization. `KONG_PLUGINS` must stay `bundled` — a partial list
  silently disables every bundled plugin the config references. The app is a
  catch-all route (`strip_path: false`); longer prefixes win.
- **Production SSR output had two latent main defects** (the build gate never
  ran the output): (1) a chunk cycle — routeTree.gen merged into a tsr-split
  chunk the shared chunk imports back → `require_shim is not a function` at
  boot, deterministic in linux containers; fixed by the `advancedChunks`
  route-tree pin in `app/vite.config.ts`. (2) react must stay SSR-external:
  bundling a second copy breaks hooks dispatch (`ReactSharedInternals.H`
  null), nitro's externals trace misses the use-sync-external-store dynamic
  requires, and the image must ship the output ALONE — real node_modules
  beside the output re-introduces the second copy and breaks every route.
- **Docker context rules**: `demo/*` stays IN the context (workspace member —
  excluding its manifests breaks `bun install --frozen-lockfile`), and
  `**/*.tsbuildinfo` + `**/.cache` stay OUT (a shipped tsbuildinfo makes the
  in-image `tsc` emit nothing; json-cms keeps state in `.cache/`).
- fmt:check on this tree still fails on the UNTRACKED `.zcode/plans/*.md`
  only (invisible to CI); `docs/supabase-handoff-2026-11-05.md` was
  committed unformatted and needed an oxfmt pass.

**Closeout follow-ups (2026-11-05, same day)**: PR #218 MERGED (main
3c3fb13). The first post-merge CI run exposed the one seam the db-name
repair missed — the two storage-api boot steps' hardcoded
`DATABASE_URL .../app` (fixed `ea1b2c0`, both now `/postgres`); confirm
that run is green before trusting main. Remaining work is the closeout
issue train: umbrella #219, ordered sub-issues #220–#230 (tracking table
in #219's first comment). Worktrees/branches cleaned: CLI stack worktree
`../jdm-supabase-backend` re-branched to `local/supabase-stack` ==
origin/main (was stuck on merged `feat/supabase-stage-0`,
0001–0002-only); `feat/project-workspace` PRESERVED + pushed (parked
unmerged Convex-era feature, worktree has uncommitted `app/convex` edits —
do not delete); superseded `feat/app-builder` archived at tag
`archive/feat-app-builder`; six merged remote branches, two merged local
branches, and the bogus `pr192` remote-tracking ref (it was a ref, not a
remote) deleted. Next-session handoff:
`docs/migration-closeout-handoff.md`.

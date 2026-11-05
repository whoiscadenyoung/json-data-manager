# Self-hosting design — one VPS, one origin, plain Docker Compose (2026-11-05)

- Status: implemented (local demo verified; VPS rollout pending)
- Decision record: [`decisions/0016-self-hosted-supabase-vps.md`](decisions/0016-self-hosted-supabase-vps.md)
- Companion material: `docs/supabase-handoff-2026-11-05.md` §1 (the initiative
  this implements), `.github/workflows/ci.yml` `store` job (the migration
  apply recipe this design mirrors), ADR 0015 (the Supabase backend itself).

The app is fully on Supabase (ADR 0015). This document specifies the
self-hosted deployment the owner approved: a single VPS running the whole
stack as plain containers, the app served at the same origin as the Supabase
APIs, deployable from CI with a `docker compose pull && up` hook.

## 1. Goals and non-goals

Goals:

- One command brings the entire stack up on a fresh machine:
  `cp .env.example .env` (generate keys) → `docker compose up -d`.
- One public origin: the app, `/rest/v1`, `/auth/v1`, `/realtime/v1`,
  `/storage/v1` behind one gateway. No CORS surface at all; cookies are
  first-party.
- The exact service generation the migration was built and verified against
  (the local CLI stack and the CI `store` job's pins) — no silent upgrades.
- Migrations apply in the same order, with the same guarantees, as CI.
- Portable compose: runs under Docker Desktop today, Colima as the
  no-admin fallback, Apple's `container` runtime as an evaluation item.

Non-goals (explicitly out, with the revisit trigger):

- Multi-node / HA topology, read replicas, managed Postgres — single VPS.
- Edge runtime / functions, logflare/vector analytics stack, imgproxy image
  transformations, S3 protocol, storage vector buckets, the connection
  pooler — the app exercises none of them; each adds containers and memory
  (the analytics stack starved the dev host twice on first bring-up — the
  note lives in `supabase/config.toml [analytics]`).
- Public Supabase Studio. Studio exists behind an opt-in compose profile,
  reachable only from the host loopback (SSH tunnel).
- Email sending: accounts are admin-created (ADR 0009 addendum — signup is
  closed), confirmations are off, so there is no SMTP container. If email
  flows (invites, recovery) are ever wanted, add an SMTP relay and unset
  `GOTRUE_MAILER_AUTOCONFIRM`.

## 2. Topology: pruned official stack vs hand-rolled slim stack

The handoff asked the design to weigh "a minimal viable stack as plain
containers vs the full official supabase/docker compose". Three options
were considered:

| Option                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full official `supabase/docker` compose                                              | Carries Envoy `api-gw` (master has replaced kong), PG 17 generation, postgrest v14/storage v1.81/realtime v2.143 — a _different generation_ than the CLI stack every test ran against; also pulls analytics/jwks/dashboards machinery we disable. Rejected as-is.                                                                                                  |
| Hand-rolled slim stack (caddy/nginx + postgrest/gotrue/storage/realtime/db, no kong) | Fewest containers, but reimplements routing subtleties kong already encodes (websocket route for realtime, storage's no-key-auth + empty-`Authorization` strip, blocked realtime admin API). Realtime + storage routing regressions would be found only at runtime. Rejected.                                                                                      |
| **Pruned official stack on kong (chosen)**                                           | Keep the official service set _minus the dropped non-goals_, kong as the gateway with a ported `kong.yml`, **image tags pinned to the generation the CLI stack runs** (read off the running containers, cross-checked against the CI `store` job). Routing is the config the app has been verified against; we own the file, so legacy-HS256 keys work end to end. |

## 3. Service inventory and image pins

| Service                              | Image (pinned)                                                                | Role                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                                 | `public.ecr.aws/supabase/postgres:15.19.0.016`                                | Postgres 15 + PostGIS + the supabase role/schema baseline. Same tag the CI `store` job and app int tests target (`ci.yml` comments: migrations must re-apply against ONE image; the docker-hub 15.8.x tag's older storage schema broke 0004 twice). |
| `auth`                               | `supabase/gotrue:v2.197.0`                                                    | Auth (password sign-in; signup disabled; admin-created accounts).                                                                                                                                                                                   |
| `rest`                               | `postgrest/postgrest:v16.5`                                                   | The Data API (`public, graphql_public` schemas).                                                                                                                                                                                                    |
| `realtime`                           | `supabase/realtime:v2.151.3`                                                  | `postgres_changes` websockets (the channel matrix from 0012/0013).                                                                                                                                                                                  |
| `storage`                            | `supabase/storage-api:v1.88.0`                                                | Object storage, file backend, the four private buckets of 0004.                                                                                                                                                                                     |
| `kong`                               | `ghcr.io/supabase/kong:2.8.1`                                                 | The single-origin gateway, declarative config from `deploy/kong.yml`.                                                                                                                                                                               |
| `app`                                | built image (`APP_IMAGE`, default `ghcr.io/<owner>/json-data-manager:latest`) | Nitro (bun preset) server + client assets.                                                                                                                                                                                                          |
| `migrations`                         | `public.ecr.aws/supabase/postgres:15.19.0.016`                                | One-shot runner: waits for db + storage, applies `supabase/migrations/*.sql`, asserts.                                                                                                                                                              |
| `studio` + `meta` (profile `studio`) | `supabase/studio:2026.11.02-sha-a05e7ec`, `supabase/postgres-meta:v0.100.0`   | Ops UI, host-loopback only.                                                                                                                                                                                                                         |

The supabase images are pulled from `public.ecr.aws` / `ghcr.io` /
`docker.io` per their upstream publishing (the CLI stack already runs these
exact digests locally; only the registry prefix differs).

Dropped vs the official compose: Envoy `api-gw` (kong instead), analytics +
logflare + vector, imgproxy + image transformation, edge-runtime/functions,
`mailpit` (no email), `webhooks`/`supabase_functions` schema bootstrap,
`_supabase` internals database, pooler (`supavisor`), S3 protocol endpoints,
storage vector buckets.

## 4. JWT and key strategy

Self-host Supabase's default is a single HS256 shared secret. Everything in
this deployment derives from one generated `JWT_SECRET`:

- `anon` and `service_role` API keys are HS256 JWTs minted from the secret
  (`deploy/scripts/generate-keys.sh`, pure bash + openssl, no runtime deps),
  carrying `{"iss":"supabase-demo","role":"anon"|"service_role"}` and a
  far-future `exp` — the same claim shape as the CI store job's demo keys.
- gotrue runs with `GOTRUE_JWT_SECRET` and **without** `GOTRUE_JWT_KEYS`, so
  it _issues_ HS256 access tokens signed with the same secret (the CLI v3
  stack instead provisions asymmetric keys and a JWKS — that is the one
  behavioral fork from the verified stack, and it is the classic
  self-host configuration every downstream service supports).
- postgrest gets `PGRST_JWT_SECRET` (raw string), storage gets
  `AUTH_JWT_SECRET`, realtime gets `API_JWT_SECRET` — all the same value;
  kong's consumers carry the two minted keys. The app's session tokens and
  the anon key therefore agree with every verifier, which is the whole
  requirement (handoff §1.1).
- No CLI-v3 _publishable/secret_ opaque keys: we own `kong.yml`, so the
  classic `apikey`-header check against the anon key is the only gate.
- What is public vs secret: the anon key and the deployment origin ship in
  the app's client bundle by design (they are publishable values — they are
  _in_ every page the browser downloads). The `JWT_SECRET`,
  `SERVICE_ROLE_KEY`, and `POSTGRES_PASSWORD` never leave the VPS `.env`.

Accounts are operator-created: `POST {origin}/auth/v1/admin/users` with
`Authorization: Bearer <SERVICE_ROLE_KEY>` + `apikey: <ANON_KEY>` (signup
disabled, `GOTRUE_DISABLE_SIGNUP=true`). Sign-in is password grant only.

## 5. Networking: one origin

`kong` is the **only** container with a published port
(`${JDM_ORIGIN_PORT:-8000}:8000`). Everything else is on the compose
network. `deploy/kong.yml` is shaped after the **CLI stack's generated config** (the
routing the app has been verified against) — `_format_version: "1.1"`, and
**no key-auth plugin at all**: authorization is enforced downstream by the
JWT-verifying services (gotrue, postgrest, storage, realtime) plus RLS,
which is also what lets signed-URL storage reads work with no `apikey`
header at all. A `request-transformer` carries a client's `apikey` into
`Authorization` when the client doesn't send one itself. No key literals
appear in the config — nothing needs substituting at start-up.

| Path                                       | Upstream               | Notes                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/v1/verify` `/callback` `/authorize` | `auth:9999`            | Unauthenticated by design (gotrue flows).                                                                                                                                                             |
| `/auth/v1/*`                               | `auth:9999`            | Authorization carried/derived; rate limits live in gotrue.                                                                                                                                            |
| `/rest/v1/*`                               | `rest:3000`            | Invalid/absent keys resolve to the RLS-fail-closed `anon` role.                                                                                                                                       |
| `/graphql/v1/*`                            | `rest:3000`            | `Content-Profile: graphql_public`.                                                                                                                                                                    |
| `/realtime/v1/` (ws)                       | `realtime:4000/socket` | Explicit ws protocol; apikey query param passes through; channel auth is the in-band token.                                                                                                           |
| `/realtime/v1/api/*`                       | `realtime:4000/api`    | Token-gated; the `openapi`/`tenants` admin routes are hard-blocked (403) on a public origin.                                                                                                          |
| `/storage/v1/*`                            | `storage:5000`         | No apikey requirement — signed URLs carry none; user JWTs ride `Authorization`.                                                                                                                       |
| **everything else**                        | `app:3000`             | The one addition vs the CLI generation: catch-all route, `strip_path: false`, so the app and the API share the origin. Kong's router prefers the longer prefix, so `/rest/v1/…` etc. always beat `/`. |

Dropped vs the CLI generation (deploy/kong.yml header has the list):
`rest-admin` (postgrest admin API — not exposed on a VPS), functions,
analytics, pooler, pg-meta (Studio reaches it directly over the loopback
profile), mcp.

Kong trusts the compose network (`X-Forwarded-*` from the gateway only);
on the VPS, TLS terminates at a **host-level Caddy** in front of kong
(documented, not composed — keeps the compose portable across hosts that
already run a reverse proxy):

```caddyfile
# /etc/caddy/Caddyfile (VPS)
jdm.example.com {
  reverse_proxy 127.0.0.1:8000
}
```

Websocket upgrade passes through both hops untouched; realtime's ws route
matches on the upgraded connection regardless of where TLS ended.

Derived auth URLs (all from `SITE_ORIGIN`, e.g. `http://localhost:8000`
locally, `https://jdm.example.com` on the VPS): `GOTRUE_SITE_URL=$SITE_ORIGIN`
(the app lives at the origin), `API_EXTERNAL_URL=$SITE_ORIGIN/auth/v1`,
`GOTRUE_JWT_ISSUER=$API_EXTERNAL_URL`, `GOTRUE_URI_ALLOW_LIST=$SITE_ORIGIN/**`,
mailer URL paths under `$SITE_ORIGIN/auth/v1/verify`.

## 6. Migration ordering and the 0004 storage trap

The trap (0004's own comment): `storage.buckets`/`storage.objects` belong to
the **storage-api service**, not the postgres image — a bare postgres boots
with the empty `storage` schema and no tables, and 0004 _loudly skips_ its
bucket/policy section when `to_regclass('storage.objects')` is null. In
compose the ordering must therefore be:

1. `db` healthy (`pg_isready` healthcheck).
2. `auth` / `rest` / `realtime` may start any time after db — they retry
   until the database accepts connections (realtime applies its own
   `_realtime` schema migrations on boot; gotrue applies its own auth
   migrations — both idempotent over the image's baseline).
3. `storage` starts after db and applies the storage schema. **CI evidence
   (ci.yml store job comment): storage-api v1.88.0 treats the first refused
   connection during postgres initdb as fatal and does not retry** — so
   `storage` depends on db _healthy_ and carries `restart: unless-stopped`
   to ride out the last moments of initdb on a cold volume.
4. `migrations` (one-shot) runs the store job's recipe
   (`deploy/scripts/apply-migrations.sh`):
   - wait for db TCP round-trip (the health gate checks the socket; TCP can
     lag and the image restarts postgres once mid-init);
   - poll storage `GET /status` until 200 (compose has no cross-container
     `exec`, and the storage image has no shell curl — the poll runs from
     the runner container over the compose network);
   - apply `supabase/migrations/*.sql` in lexical order
     (`LC_ALL=C`, byte-order sort so zero-padded names apply in numeric
     order) with `psql -v ON_ERROR_STOP=1 -f`;
   - assert, exactly like CI: `postgis_version()` returns a version
     string, `storage.buckets` holds the four private buckets
     (`geometries`, `marker-sprites`, `source-files`, `tile-archives`),
     and `pg_policies` on `storage.objects` counts exactly 8 (the 0004/0006
     set). If the storage section silently skipped, the runner fails and
     `docker compose up` is visibly red.
   - Bookkeeping lives in `supabase_migrations.schema_migrations`
     (version = filename stem), matching the CLI's table so the same
     directory keeps working under `supabase db` tooling; applied files
     are skipped on re-run.

The database role baseline comes from a small initdb script
(`deploy/postgres/zz-supabase-roles.sh`): reset the service-role passwords
(`authenticator`, `supabase_auth_admin`, `supabase_storage_admin`,
`supabase_replication_admin`, `supabase_read_only_user`, `postgres`) to
`$POSTGRES_PASSWORD` — the image creates the roles in its own
`migrate.sh`-driven init-scripts, which is also why the script is named
`zz-` (it must sort after `migrate.sh`; an earlier-sorted script runs
against zero roles) — and create the `_realtime` schema owned by `postgres`
(the schema realtime's `DB_AFTER_CONNECT_QUERY` points at). It runs once,
on first volume init, before any service connects.

One more image flag: the db boots with `-c cron.database_name=app`.
Migration 0012 creates pg_cron (the weekly bindings reconcile), and
pg_cron's extension may only be created in the database named by
`cron.database_name` — a **postmaster-context** GUC, so there is no
session- or database-level workaround (`ALTER DATABASE … SET` is refused).
The image defaults it to `postgres`; this stack's database is `app`, so the
flag goes on at boot, where the pg_cron launcher also picks jobs up from
`app`. CI cannot pass server args to service containers, which is why
`ci.yml`'s services run against the image-default database name instead
(fixed there 2026-11-05 — the store and ci jobs had been red on main since
0012 landed; the local gate suite applied against a postgres-named db and
never saw it).

## 7. The app image

`Dockerfile` (repo root, build context = repo root — the build needs the
bun workspace: `app/` plus the `@caden/*` packages it imports):

- **Builder** `oven/bun:1.3.5` — the version CI and the dev machine pin:
  - copy manifests + `bun.lock`, `bun install --frozen-lockfile`
    (BuildKit cache mount for `~/.bun/install/cache`);
  - build the package dists the app consumes through their exports, in
    CI's order and for CI's reason: `@caden/data-core`, `@caden/importers`
    (json-cms compiles against their dists), then `@caden/json-cms`,
    `@caden/geometry-archive`;
  - `ENV VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from `ARG`s (see §4:
    publishable values, baked at build), then `bun --filter=app run build`
    → nitro `bun` preset emits a self-contained `.output`
    (`server/index.mjs` + `public/`).
- **Runtime** `oven/bun:1.3.5-slim`: `HOST=0.0.0.0`, `PORT=3000`,
  `CMD ["bun", ".output/server/index.mjs"]`. No node_modules ship — the
  nitro output bundles everything.

A `.dockerignore` prunes `node_modules`, `app/.output`, `.git`, docs,
exports, demo fixtures, and the convex local-storage droppings so the
context stays small and the build never sees stale artifacts.

Because env is baked at build, a new deployment origin means a rebuild (CI
re-runs with the new `VITE_SUPABASE_URL` variable). The alternative —
runtime injection via a generated `/env.js` + an `env.ts` fallback — was
considered and deferred: it touches app source for a benefit (one
origin-agnostic image) the single-VPS deployment does not need yet
(recorded in §14 as the first revisit item).

Serving the production output also surfaced two real defects on main
(found 2026-11-05 while verifying this design — the build gate never _ran_
the output before):

1. **Chunk cycle at SSR boot**: rolldown's small-chunk merging sometimes
   folds `routeTree.gen` into a server route-split chunk that the shared
   server chunk imports back; evaluation order then hands out
   uninitialized bindings (`require_shim is not a function` at boot).
   Deterministic in the linux container build, latent elsewhere. Fixed in
   `app/vite.config.ts` by pinning the route tree into its own
   `advancedChunks` group.
2. **Runtime-external react**: nitro's externals trace misses dynamic
   requires inside bundled CJS shims (use-sync-external-store via
   recharts/zustand). react itself must stay external — the SSR react-dom
   copy and every hook consumer have to resolve the same instance, and
   bundling a second copy breaks hooks dispatch (`ReactSharedInternals.H`
   null on every route) — while with nothing resolvable at runtime,
   nitro's `__require` fallback serves the one inlined copy. The image
   therefore ships the output ALONE, no node_modules; shipping real
   modules beside the output actively breaks it (the Dockerfile records
   the experiment).

## 8. Compose and env contract

`docker-compose.yml` (root) — services: `db`, `auth`, `rest`, `realtime`,
`storage`, `kong`, `app`, `migrations` (one-shot), `studio` + `meta` behind
`profiles: ["studio"]` (published on `127.0.0.1:${STUDIO_PORT:-54323}`).
`app` carries both `image: ${APP_IMAGE}` and a `build:` section: the local
demo builds it from source; the VPS pulls the GHCR image and never builds.

`.env.example` (root), copied to `.env`:

| Variable                                       | Meaning                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SITE_ORIGIN`                                  | Public origin (also the app's own URL; default `http://localhost:8000`).                        |
| `JDM_ORIGIN_PORT`                              | Host port kong publishes (default 8000).                                                        |
| `POSTGRES_PASSWORD`                            | DB superuser + service-role password.                                                           |
| `JWT_SECRET`                                   | The HS256 secret everything derives from.                                                       |
| `ANON_KEY` / `SERVICE_ROLE_KEY`                | Minted by `deploy/scripts/generate-keys.sh`.                                                    |
| `APP_IMAGE`                                    | `ghcr.io/<owner>/json-data-manager:latest` (local demo: built from the `build:` section).       |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | App build args (= `SITE_ORIGIN` / `ANON_KEY`).                                                  |
| `STUDIO_PORT`                                  | Studio profile only (host-loopback binding; no dashboard credentials — the tunnel is the gate). |

`docker compose --profile studio up -d` for the ops UI; plain `up -d` never
starts it.

## 9. CI/CD

`.github/workflows/deploy.yml`:

- **build** — on push to `main` (paths: app, packages, Dockerfile,
  compose, migrations) + `workflow_dispatch`: buildx, GHCR login with
  `GITHUB_TOKEN` (`permissions: packages: write`), push
  `ghcr.io/<owner>/json-data-manager:{latest,<sha>}` with
  `VITE_SUPABASE_URL=${{ vars.PUBLIC_SUPABASE_URL }}` and
  `VITE_SUPABASE_ANON_KEY=${{ vars.PUBLIC_SUPABASE_ANON_KEY }}` as build
  args. Both are repository **variables** (they are public values, §4) —
  if unset, the image bakes placeholder values and stays runnable behind
  any origin that bakes its own.
- **deploy** — `needs: build`, and **guarded**:
  `if: vars.DEPLOY_SSH_HOST != ''`. Sets up an SSH key from secrets,
  `ssh $DEPLOY_SSH_HOST "cd $DEPLOY_PATH && docker compose pull &&
docker compose up -d"` (the one-shot `migrations` service runs inside
  that `up`, so schema changes ride the same hook).

Repo operating notes: pushes touching `.github/workflows/` need the SSH
host alias `github.com-whoiscadenyoung` (the gh token lacks the `workflow`
scope — `docs/memory/gh-push-workflow-scope.md`). Merges stay gated on the
local gate suite, not CI waits.

## 10. Backups

`deploy/scripts/backup.sh` (host cron, e.g. nightly):

- `docker exec jdm-db pg_dump -U supabase_admin -d app -Fc > backup/app-YYYYmmdd.dump`
- `tar czf backup/storage-YYYYmmdd.tgz` the storage volume path
  (the compose mounts a named volume; the script writes through
  `docker run --rm -v` Alpine tar, so it works regardless of where the
  volume lives).

Restore: `docker exec -i jdm-db pg_restore -U supabase_admin -d app --clean`
the dump, untar the storage volume, `docker compose up -d`. Keep N nights
on-host; `rclone`/rsync off-box is the operator's choice (design leaves the
off-box copy to the VPS's existing backup habit).

### Restore rehearsal (executed 2026-11-05, issue #230)

- `backup.sh` produced the dump + storage tar; the dump restored into a
  scratch database (`app_rehearsal`) with identical row counts (users 3,
  datasets 3, apps 2) and intact demo rows; the storage tar untarred into a
  scratch volume with an identical file-hash set (md5 over all files).
  Both scratch targets were dropped after verification — the live stack
  was never touched.
- Two rehearsal defects found and fixed in `backup.sh` itself: the volume
  name must be compose-normalized (`${PROJECT}_storage-data`, UNDERSCORE —
  a hyphen guess silently auto-creates an EMPTY named volume), with a
  `docker volume inspect` guard and an empty-volume tripwire so both
  failures are loud.
- `--clean` restore notes: pg_restore reports ~20 non-fatal errors dropping
  partition-inherited PK constraints (`auth.messages_*` daily partitions —
  inherited constraints cannot be dropped standalone); the data restore
  completes and counts verify. A same-db `--clean` cutover should drop the
  partitions' parent first (or restore into a fresh db and rename, the
  rehearsal's shape).

## 11a. VPS go-live handoff (the remaining cutover, post-rehearsal)

The local compose deployment is the verified reference; the VPS cutover is
the same commands with operator inputs:

1. Provision the host (§11 sizing), install Docker + compose.
2. Copy the repo (or just `deploy/`, `supabase/migrations/`, `docker-compose.yml`,
   `.env.example`) to `/srv/jdm`.
3. `.env`: `cp .env.example .env` then `deploy/scripts/generate-keys.sh`
   (fresh keys — do NOT reuse local secrets; note `SITE_URL`/origin).
4. `docker login ghcr.io` (the app image is private GHCR).
5. `docker compose up -d` — the migrations runner applies the numbered set
   idempotently; verify `curl :8000/status` (kong) and sign in.
6. Cron the backup: `15 4 * * * /srv/jdm/deploy/scripts/backup.sh /srv/jdm`.
7. Off-box: rsync/rclone `backups/` to a second location nightly.
8. DNS + TLS: terminate TLS in front of kong (Caddy/nginx/traefik) or add a
   kong cert; set the origin in `.env` to the public URL.
9. Verify: sign-in, an import, a map open, a realtime second tab, one
   backup + restore rehearsal on the VPS.

## 11. VPS sizing and runtime portability

- **Floor**: 2 vCPU / 4 GB RAM. The five supabase containers idle well
  under 1.5 GB with the analytics/log stack gone; the app image adds
  ~100–200 MB; Postgres wants page cache for the dataset working set.
- **Comfortable**: 4 vCPU / 8 GB + 2 GB swap — headroom for 20k–50k-point
  imports, tile-archive builds, and Studio sessions.
- **Disk**: Postgres data + the storage volume (source files, tile
  archives) — size to the dataset habit; 40 GB is a sane start.
- Compose targets standard Docker (Docker Desktop runs it today; Colima is
  the no-admin fallback — `colima start` then the same commands). Apple's
  `container` runtime stays an evaluation item: nothing in the compose
  uses Docker-specific features beyond bind mounts + healthchecks, so the
  port is expected to be mechanical, but it is not a target.

## 12. Local demo runbook (what "done" means for this design)

```sh
cp .env.example .env
deploy/scripts/generate-keys.sh   # prints values to paste into .env
docker compose up -d --build      # builds the app image locally
docker compose logs -f migrations # exits 0 with the three asserts green

# through the single origin (kong):
curl -fsS http://localhost:8000/                       # app 200
curl -fsS http://localhost:8000/auth/v1/health         # gotrue healthy
# operator creates a user (service_role):
curl -X POST http://localhost:8000/auth/v1/admin/users \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@jdm.test","password":"demo-password-1","email_confirm":true}'
# password grant:
curl -X POST http://localhost:8000/auth/v1/token?grant_type=password \
  -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"email":"demo@jdm.test","password":"demo-password-1"}'
# dataset insert + RPC with the user's access token:
curl -X POST http://localhost:8000/rest/v1/datasets \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" \
  -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
  -d '{"title":"demo"}'
curl -X POST http://localhost:8000/rest/v1/rpc/search_entries ...
# storage policy round-trip (0004 end-to-end):
#   upload a small object into geometries/<datasetId>/… with the user JWT,
#   then mint a signed URL and GET it.
```

Pass criteria: migrations runner green with all asserts, app 200 through
kong, auth grant issues an HS256 token PostgREST accepts, RLS permits the
creator's dataset insert, `search_entries` answers, storage upload +
signed read succeed. A browser smoke (sign-in → dataset page) through the
same origin closes the demo.

## 13. Deviations from the CLI stack (deliberate, testable)

1. **Database name `app`**, not `postgres` — matches CI's store job
   (`POSTGRES_DB=app`); all service URLs name it explicitly.
2. **HS256-only keys** (§4) — the CLI stack provisions asymmetric
   `GOTRUE_JWT_KEYS` + JWKS on postgrest/realtime/storage; classic
   self-host shares one secret. Verified by the demo's grant → insert →
   RPC chain.
3. **Signup disabled via `GOTRUE_DISABLE_SIGNUP=true`** with no SMTP
   container (CLI runs mailpit + inflated email rate limits for tests).
4. **No edge-runtime / supabase_functions schema** (CLI's db bootstrap
   creates them; we drop the block — nothing in the app calls hooks).
5. **kong instead of Envoy**, tags pinned to the CLI generation (§3).
6. **No Studio by default**; the `studio` profile is loopback-only.

## 14. Deferred / revisit

- Runtime env injection (one origin-agnostic image) — §7.
- TLS inside compose (kong ssl listener) if the host has no reverse proxy.
- pg_cron backfill for storage-backed oversized geometries in frozen
  versions (handoff §2, recorded at 0009:515-532) — orthogonal to this
  design, same migration-ordering discipline applies.
- Apple `container` runtime port (§11).

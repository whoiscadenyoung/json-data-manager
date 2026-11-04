# 16. The app self-hosts on a single VPS as a pruned official Supabase stack behind one Kong origin, deployed from GHCR images

- Status: accepted
- Date: 2026-11-05
- Companion design (the implementation contract):
  [`../self-hosting-design.md`](../self-hosting-design.md)
- Builds on ADR 0015 (the Supabase backend); does not supersede any ADR.

## Context

ADR 0015 rewrote the backend on self-hosted Supabase; every stage merged
and the app runs entirely on Postgres + PostGIS, Auth, Realtime, and
Storage. The migration handoff (`docs/supabase-handoff-2026-11-05.md` §1)
left deployment as the last initiative: the local stack runs under the
Supabase CLI's Docker containers, nothing ships to a server yet, and the
owner wants self-hosting on a VPS — Docker CLI / DevContainers / Apple
Containers locally as the demo path, ending in `docker-compose.yml` +
`Dockerfile(s)` deployable from CI.

Constraints that shaped the decision:

- The app consumes `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` and the
  anon key is a publishable value; self-host's default key scheme is a
  single HS256 secret from which the API keys derive.
- Migration 0004's storage section only applies where the storage-api
  service has created its tables — deployment ordering is load-bearing,
  and the CI `store` job already encodes the correct recipe.
- The runtime target is standard Docker Compose (Colima fallback; Apple's
  `container` runtime is an evaluation item, not a target).
- The CLI stack's service generation (kong 2.8.1, gotrue v2.197.0,
  postgrest v16.5, realtime v2.151.3, storage-api v1.88.0, supabase/
  postgres 15.19.0.016) is the one every test and the CI `store` job
  verify against.

## Decision

- **Self-host on a single VPS with a pruned official Supabase stack in one
  `docker-compose.yml`**: db, auth (gotrue), rest (postgrest), realtime,
  storage, kong, the app, and a one-shot migrations runner. Analytics/
  logflare/vector, imgproxy, edge-runtime/functions, mailpit, the pooler,
  the S3 protocol, and storage vector buckets are out — the app exercises
  none of them. Studio rides an opt-in compose profile, published on host
  loopback only.
- **Image tags pin to the CLI/CI generation**, not to the official
  compose's current master (which has moved to Envoy + PG 17 + a newer
  service set). Same-pins-as-verified beats newest.
- **One origin via Kong**: kong is the only published container; its
  declarative config ports the official routing plus a catch-all route to
  the app container, so the app and `/rest/v1` `/auth/v1` `/realtime/v1`
  `/storage/v1` share the public origin. TLS terminates at a host-level
  reverse proxy (Caddy) on the VPS, outside the compose.
- **Classic HS256 keys**: one generated `JWT_SECRET`; anon/service_role
  keys minted from it; gotrue configured with `GOTRUE_JWT_SECRET` (no
  asymmetric keys) so user tokens verify everywhere with the same secret.
  The CLI-v3 publishable-key scheme is not used. Signup stays disabled
  (ADR 0009 addendum); accounts are operator-created through the admin
  API with the service key.
- **The app ships as a multi-stage bun image** (builder: workspace install
  → package dists → `vite build` with nitro's bun preset; runtime: slim
  bun serving `.output`). `VITE_*` values are **baked at build time** from
  repository variables — they are publishable by design; the deployment's
  real secrets (`JWT_SECRET`, `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD`)
  live only in the VPS `.env`.
- **Migrations run in-band** as a one-shot compose service executing the
  CI store job's recipe (wait db, wait storage `/status`, lexical apply
  with `ON_ERROR_STOP`, then the same three asserts), gated behind storage
  because of the 0004 trap. Bookkeeping uses the CLI's
  `supabase_migrations.schema_migrations` table.
- **CI/CD**: a deploy workflow builds and pushes the app image to GHCR and
  runs an SSH deploy hook (`docker compose pull && up -d`) guarded on
  deployment variables being configured.

## Consequences

- A fresh VPS (or laptop) reaches a running stack with: copy `.env`,
  generate keys, `docker compose up -d`. No Supabase CLI in the runtime
  path; the CLI remains the local-dev convenience (config.toml unchanged)
  and CI remains the migration gate.
- Changing the deployment origin requires an image rebuild (CI re-bakes
  the two public values). If one origin-agnostic image is ever needed, the
  design doc's §14 records the runtime-injection path.
- The one behavioral fork from the verified CLI stack is HS256-only keys
  (the CLI provisions asymmetric keys + JWKS); the demo's grant → insert →
  RPC → storage chain is the acceptance test that the classic scheme holds.
- Kong's catch-all makes the origin the security boundary: the app and the
  APIs are same-origin, CORS disappears, and the blocked realtime admin
  routes plus admin-only ACLs carry over unchanged from the official
  config.
- Backups are operator-run (`deploy/scripts/backup.sh`: `pg_dump -Fc` +
  storage tar) until an off-box habit exists; restore is pg_restore +
  untar + `up -d`.

# Supabase migration — handoff for the next session (2026-11-05)

The Convex → Supabase migration is **complete**: umbrella #198 closed, all
eight stages plus the app-builder follow-up (#216) merged, the app runs
entirely on Supabase (Postgres 17 + PostGIS, Auth, Realtime, Storage), and
`app/convex/` + `packages/json-cms/` remain in-tree untouched and unmounted.
Main is at `b18b8c9` with migrations `0001–0014`. Full per-stage record:
#198's closing comment; per-PR review findings live on each PR (#207–#217).

This doc is the handoff: what remains, in priority order.

## 1. VPS self-hosting initiative (approved, not started)

The owner wants self-hosting designed and demoed locally (Docker CLI /
DevContainers / Apple Containers), ending in `docker-compose.yml` +
`Dockerfile`(s) for CI/CD deployment. Suggested shape:

1. `docs/self-hosting-design.md` — architecture: a minimal viable stack as
   plain containers (postgres+postgis, gotrue, postgrest, realtime,
   storage-api, one gateway) vs the full official supabase/docker compose;
   JWT/key strategy (self-host default is HS256; the app only needs the anon
   key + user tokens to agree with PostgREST/gotrue config); networking (one
   origin fronting app + `/rest/v1` `/auth/v1` `/realtime/v1` `/storage/v1`);
   backups; VPS sizing.
2. App image: multi-stage `Dockerfile` — bun install → `bun --cwd app run
   build` (nitro `bun` preset) → runtime serving `.output`.
3. `docker-compose.yml` + `.env.example` (generated keys), app on :3000.
4. **Known trap**: migration `0004`'s storage section is gated on the
   storage-api tables existing (the service owns them, not the postgres
   image) — in compose, run migrations AFTER storage-api is healthy, or
   bootstrap buckets post-boot. Same class of issue as the CI store job's
   history (PRs #207/#208 reviews).
5. Local demo verification: `docker compose up -d` → app 200, auth grant
   works, dataset create + `search_entries` via PostgREST with a seeded user.
6. CI/CD: GitHub Actions building/pushing the app image (GHCR) + a deploy
   hook (`ssh vps "docker compose pull && docker compose up -d"`).
7. Runtime note: compose targets standard Docker (Docker Desktop runs it
   today); Colima is the no-admin fallback; Apple's `container` runtime is an
   evaluation item, not a target — keep the compose portable.

## 2. Recorded review findings to address (small, file-pointed)

From the per-PR fresh-eyes reviews (each PR's findings in the run report /
PR comments):

- `app/src/lib/store/apps.ts:143-152` — "Your apps" reads newest-200 across
  ALL users and filters creator client-side; add `.eq("created_by", userId)`
  (Convex scoped by index first; #217 review, medium).
- App content-shape validation gap: PG save checks only pages 1..12 and ≤80
  widgets vs Convex's full assertContentShape + dataset-ref visibility
  (#217 review, medium).
- `use-app-editor.ts:67-68` — bare unsafe-cast warning needs the scoped
  disable treatment (#217 review, low).
- Examples gallery order needs `, id` tiebreaker (identical created_at;
  #217 review, low).
- 0014 header says seeded pages are "verbatim" — the visits valueField was
  deliberately repaired (`visitors_millions`); reword (#217 review, low).
- Remaining stage-6/7 mediums: consumer_references + version_policies are
  outside the realtime channel matrix (recorded in realtime.ts:107-116);
  binding_sweep_batch / binding_fail_run skip the claim/gate restatement
  (0012:1305-1372); frozen versions are not self-contained for
  storage-backed oversized geometries (0009:515-532 — pg_cron backfill or
  louder consumer refusal); derived save-refusal copy drift
  (derived.ts:808); linkMapLayers' leg-time read caps at 500 vs Convex's
  1000 (publishing.ts); publish_version `publish_key = ref` invariant
  deserves one comment line (0011); stage-7's one bare lint warning
  (pg-stage7-bindings.int.test.ts:657); dormant convex imports kept in the
  client bundle (tile-archive.ts:26,329; pg-transform-editor.tsx:38-45) —
  cleanup candidates.

## 3. Manual verification checklist (not yet run live)

- Browser pass: sign-in → import → table sort/filter/search → map → publish
  → version compare → app-builder grid + seeded example.
- Two-browser realtime test (one tab edits, another sees the change <1 s).
- §15 devtools inspection: zero Convex network calls (the static build grep
  found none — this is the dynamic confirmation).
- 20k A/B **browser** cold-open timing (the headless bench measured import
  3.59–4.13 s vs Convex 17.30 s; the cold-open/tile number is unmeasured).

## 4. Deferred by decision (tracked)

- #216 follow-ups: apps table in the realtime channel matrix (optional,
  recorded at 0014:93-95); Parquet sidecar (analysis layer, long-standing).
- Deployment shape: VPS self-host (this doc §1) vs Supabase cloud — owner
  chose self-host direction.
- `feat/project-workspace` worktree + `claude/pensive-chaum-f0d934` branch
  predate this migration and were untouched by it — reconcile separately.

## 5. Environment notes

- The local stack (Docker Desktop) is managed from the
  `../jdm-supabase-backend` worktree's `supabase/` dir (that worktree must
  stay); `bunx supabase status -o env` from there prints keys. `supabase db
  reset` from any checkout with the same config reapplies ALL migrations and
  WIPES data.
- Bench fixtures: `/tmp/jdm-ab/` (gen-points.ts, serve.ts, bench-import.ts,
  points20k.geojson); bench user `bench@jdm.test` /
  `bench-password-1` (recreate via the gotrue **admin** API with
  `SECRET_KEY` — signup is disabled locally).
- Known flaky tests under machine load (pass in isolation; green in CI):
  `convex/versions/consumption.test.ts` (5 s timeouts) and
  `pg-realtime.int.test.ts` delivery assertions (15 s window) — do not
  "fix" these; rerun isolated.
- Merges in this effort gated on the local world.run gate suite (27 commands
  mirroring ci.yml) per the standing no-CI-wait directive; stacked PRs must
  be **retargeted to main before merging** (gh merges into the PR's base).
- Pushes touching `.github/workflows/` need the SSH host alias
  `github.com-whoiscadenyoung` (the gh token lacks the workflow scope).

#!/usr/bin/env bash
# Local equivalent of the `full` job in .github/workflows/ci.yml — the whole
# gate with ZERO Actions minutes (minutes are budget-limited; the workflow
# only runs `full` on dispatch / main pushes since 2026-11-09).
#
# Boots a throwaway CI-PARITY stack (bare supabase/postgres + storage-api),
# applies the migration set, then runs every gate: dists, fmt, lint,
# typechecks, package tests, the app suite (PG int tests included), app
# build. Everything self-cleans on exit.
#
# The int tests REQUIRE a dedicated db: against the live compose db the
# count/closure assertions inflate with real app data and fail
# (docs/memory/int-test-db-split-ri-teardown.md). This script replicates
# CI's bare service container, not the compose stack.
#
# Usage: scripts/local-gate.sh [--skip-docker]   (--skip-docker reuses a
#   stack you already booted via the same env vars: JDM_GATE_PG_URL must be
#   set and reachable; storage sections of 0004/0006 will be skipped by the
#   to_regclass guards and storage int tests may fail without it.)
set -euo pipefail
cd "$(dirname "$0")/.."

PG_IMAGE="public.ecr.aws/supabase/postgres:15.19.0.016"
STORAGE_IMAGE="public.ecr.aws/supabase/storage-api:v1.88.0"
PG_PORT="${PG_PORT:-5433}"
STORAGE_PORT="${STORAGE_PORT:-5001}"
NET="jdm-local-gate"
PG_CONTAINER="jdm-local-gate-pg"
STORAGE_CONTAINER="jdm-local-gate-storage"
# supabase local-dev demo JWTs (public; only boot validation reads them —
# same values ci.yml boots with).
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

cleanup() {
  docker rm -f "${PG_CONTAINER}" "${STORAGE_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

export SUPABASE_DB_URL="postgresql://supabase_admin:postgres@127.0.0.1:${PG_PORT}/postgres"

if [ "${1:-}" != "--skip-docker" ]; then
  echo "== booting CI-parity stack (pg :${PG_PORT}, storage-api :${STORAGE_PORT})"
  docker network create "${NET}" >/dev/null
  docker run -d --name "${PG_CONTAINER}" --network "${NET}" \
    -p "127.0.0.1:${PG_PORT}:5432" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
    "${PG_IMAGE}" >/dev/null
  for i in $(seq 1 30); do
    docker exec "${PG_CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 2
  done
  docker exec "${PG_CONTAINER}" pg_isready -U postgres >/dev/null

  # storage-api BEFORE migrations (0004/0006 apply their storage sections
  # against its schema; the ci job's boot order, #234/#248).
  docker run -d --name "${STORAGE_CONTAINER}" --network "${NET}" \
    -p "127.0.0.1:${STORAGE_PORT}:5000" \
    -e "DATABASE_URL=postgresql://supabase_admin:postgres@${PG_CONTAINER}:5432/postgres" \
    -e "ANON_KEY=${ANON_KEY}" \
    -e "SERVICE_KEY=${SERVICE_KEY}" \
    -e AUTH_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long \
    -e STORAGE_BACKEND=file \
    -e FILE_STORAGE_BACKEND_PATH=/tmp/storage-data \
    -e FILE_SIZE_LIMIT=52428800 \
    "${STORAGE_IMAGE}" >/dev/null
  for i in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${STORAGE_PORT}/status" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS "http://127.0.0.1:${STORAGE_PORT}/status" >/dev/null \
    || { echo "storage-api never became healthy" >&2; docker logs "${STORAGE_CONTAINER}" >&2; exit 1; }

  echo "== applying migrations"
  export LC_ALL=C
  shopt -s nullglob
  migrations=(supabase/migrations/*.sql)
  [ "${#migrations[@]}" -gt 0 ] || { echo "no migrations found" >&2; exit 1; }
  for f in "${migrations[@]}"; do
    echo "  applying ${f}"
    docker exec -i "${PG_CONTAINER}" psql -U supabase_admin -d postgres \
      -v ON_ERROR_STOP=1 -q -f - < "${f}"
  done
  echo "  applied ${#migrations[@]} migration(s)"
else
  [ -n "${JDM_GATE_PG_URL:-}" ] || { echo "--skip-docker needs JDM_GATE_PG_URL" >&2; exit 1; }
  SUPABASE_DB_URL="${JDM_GATE_PG_URL}"
fi

step() { printf '\n== %s\n' "$1"; }

step "bun install"
bun install --frozen-lockfile

step "build workspace dists"
bun --filter=@caden/data-core run build
bun --filter=@caden/importers run build
bun --filter=@caden/json-cms run build
bun --filter=@caden/geometry-archive run build
bun --filter=@caden/data-export run build

step "format check"
bun run fmt:check

step "lint"
bun run lint

step "typechecks"
for p in @caden/data-core @caden/importers @caden/json-cms @caden/geometry-archive \
         @caden/ui @caden/maps @caden/layer-styles @caden/analysis @caden/data-export; do
  echo "  ${p}"
  bun --filter="${p}" run typecheck
done
echo "  app"
(cd app && bunx tsc --noEmit)

step "package tests"
for p in @caden/data-core @caden/importers @caden/json-cms @caden/geometry-archive \
         @caden/maps @caden/layer-styles @caden/analysis @caden/data-export; do
  echo "  ${p}"
  bun --filter="${p}" run test
done

# The server-side view runner reads these (docs/views-design.md §7). The int
# tests connect through SUPABASE_DB_URL; exporting the runner's own names keeps
# any app code path that goes through entry.server.ts working in the gate too.
export DATABASE_URL="${SUPABASE_DB_URL}"
export JWT_SECRET="${JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"

step "app tests (PG int suites included)"
(cd app && SUPABASE_DB_URL="${SUPABASE_DB_URL}" bun run test)

step "app build"
bun --filter=app run build

printf '\n== LOCAL GATE GREEN — mirrors ci.yml `full` ==\n'

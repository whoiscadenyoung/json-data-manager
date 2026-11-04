#!/usr/bin/env bash
# One-shot migration runner for the compose deployment
# (docs/self-hosting-design.md §6) — the CI store job's recipe
# (.github/workflows/ci.yml, `store` job) adapted for containers:
#
#   1. wait for postgres over TCP (the compose health gate checks the unix
#      socket; TCP can lag and the image restarts postgres once mid-init),
#   2. wait for storage-api /status — the 0004 trap: storage.buckets/
#      storage.objects belong to the storage-api service; if the storage
#      section of 0004/0006 ran before its tables existed it would skip
#      loudly and the buckets/policies would never exist,
#   3. apply supabase/migrations/*.sql in lexical order (LC_ALL=C byte
#      sort, psql -v ON_ERROR_STOP=1), skipping anything already recorded
#      in supabase_migrations.schema_migrations (the CLI's bookkeeping
#      table, so `docker compose up` stays idempotent),
#   4. assert what CI asserts: PostGIS answers with a version, the four
#      private buckets exist, and storage.objects carries exactly the 8
#      policies the migration set installs.
#
# Runs inside the supabase/postgres image (has psql + bash). Env:
#   DATABASE_URL  - postgresql://supabase_admin:…@db:5432/app
#   STORAGE_HOST / STORAGE_PORT - storage-api's address on the compose net
#   MIGRATIONS_DIR - where supabase/migrations is mounted (default /migrations)
set -euo pipefail
export LC_ALL=C

: "${DATABASE_URL:?DATABASE_URL is required}"
STORAGE_HOST="${STORAGE_HOST:-storage}"
STORAGE_PORT="${STORAGE_PORT:-5000}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

log() { printf '[migrations] %s\n' "$*"; }

# --- 1. postgres ---
for i in $(seq 1 30); do
  if psql "$DATABASE_URL" -X -c 'select 1;' >/dev/null 2>&1; then break; fi
  log "waiting for postgres (attempt ${i}/30)..."
  sleep 2
done
if ! psql "$DATABASE_URL" -X -c 'select 1;' >/dev/null 2>&1; then
  log "postgres never became reachable at DATABASE_URL"
  exit 1
fi

# --- 2. storage-api (owns storage.objects — see the 0004 header) ---
# Readiness signal = the storage tables themselves: storage-api applies its
# schema migrations before it starts serving, and `storage.objects` existing
# is exactly the condition 0004's guard tests (and the only one the bucket
# INSERT needs). Polling the DB (not HTTP) also sidesteps this image's bash
# being built without /dev/tcp net-redirections.
storage_ready() {
  [ "$(psql "$DATABASE_URL" -X -tA -c \
    "select to_regclass('storage.objects') is not null;")" = "t" ]
}
for i in $(seq 1 60); do
  if storage_ready; then break; fi
  log "waiting for storage-api schema (attempt ${i}/60)..."
  sleep 2
done
if ! storage_ready; then
  log "storage-api never created its schema (storage.objects still absent)"
  log "the storage sections of 0004/0006 must NOT be applied blind — fix storage first"
  exit 1
fi
log "storage schema present"

# --- 3. bookkeeping + apply ---
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text,
  inserted_at timestamptz not null default now()
);
SQL

shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)
if [ "${#migrations[@]}" -eq 0 ]; then
  log "no migrations found under ${MIGRATIONS_DIR}/"
  exit 1
fi

applied=0
skipped=0
for f in "${migrations[@]}"; do
  version="$(basename "$f" .sql)"
  if psql "$DATABASE_URL" -X -tA -c \
    "select 1 from supabase_migrations.schema_migrations where version = '$version';" \
    | grep -q 1; then
    skipped=$((skipped + 1))
    continue
  fi
  log "applying $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -f "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c \
    "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$version');"
  applied=$((applied + 1))
done
log "applied ${applied}, skipped ${skipped} previously applied"

# --- 4. asserts (mirror ci.yml `store`) ---
postgis="$(psql "$DATABASE_URL" -X -tA -c 'select postgis_version();')"
case "$postgis" in
  [0-9]*)
    log "PostGIS present: ${postgis%% *}"
    ;;
  *)
    log "postgis_version() returned '${postgis}' — expected a version string"
    exit 1
    ;;
esac

buckets="$(psql "$DATABASE_URL" -X -tA -c 'select id from storage.buckets order by id;')"
# 0004's four §6 buckets + sync-chunks (0012 §3.6 — chunk blobs ride Storage).
expected=$'geometries\nmarker-sprites\nsource-files\nsync-chunks\ntile-archives'
if [ "$buckets" != "$expected" ]; then
  log "storage.buckets are '${buckets//$'\n'/,}' — expected the §6 buckets + sync-chunks (geometries,marker-sprites,source-files,sync-chunks,tile-archives)"
  exit 1
fi

n="$(psql "$DATABASE_URL" -X -tA -c \
  "select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects';")"
if [ "$n" -ne 8 ]; then
  log "storage.objects carries ${n} policies — expected exactly the 8 the migration set installs (0004/0006)"
  exit 1
fi

log "verified: PostGIS live, 5 buckets, 8 object policies"

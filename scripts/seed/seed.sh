#!/usr/bin/env bash
# Load a seed snapshot (scripts/seed/export.sh) into a fresh stack.
#
#   scripts/seed/seed.sh [--from seed-data] [--reset]
#
# Run AFTER the stack is up and migrated (`docker compose up -d`; the
# `migrations` service has finished and gotrue has booted). Refuses to touch a
# target that already holds datasets unless --reset (which TRUNCATEs every
# public table and auth.users — fine for a fresh environment, destructive for
# a live one).
#
# Env (defaults from .env, or SEED_ENV_FILE for the TARGET stack):
#   SEED_DB_CONTAINER=jdm-db   SITE_ORIGIN   SERVICE_ROLE_KEY   [STORAGE_URL]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FROM="$ROOT/seed-data"
RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --reset) RESET=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -f "$FROM/db.dump" ] && [ -f "$FROM/storage.json" ] || { echo "no snapshot in $FROM (run export.sh)" >&2; exit 1; }

set -a; [ -f "${SEED_ENV_FILE:-$ROOT/.env}" ] && . "${SEED_ENV_FILE:-$ROOT/.env}"; set +a
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY not set (source .env or SEED_ENV_FILE)}"
export STORAGE_URL="${STORAGE_URL:-${SITE_ORIGIN:-http://localhost:8000}/storage/v1}"
export SERVICE_ROLE_KEY

DB="${SEED_DB_CONTAINER:-jdm-db}"
DBNAME="${SEED_DB_NAME:-app}"
psql_t() { docker exec -i "$DB" psql -U supabase_admin -d "$DBNAME" -X -v ON_ERROR_STOP=1 "$@"; }
log() { printf '[seed] %s\n' "$*"; }

log "target: container $DB, db $DBNAME, storage $STORAGE_URL"
[ "$(psql_t -Atc "select to_regclass('public.datasets') is not null and to_regclass('auth.users') is not null")" = t ] \
  || { echo "target has no schema yet — wait for the migrations service to finish" >&2; exit 1; }

existing="$(psql_t -Atc "select count(*) from public.datasets")"
if [ "$existing" != 0 ] && [ "$RESET" != 1 ]; then
  echo "target already has $existing datasets; re-run with --reset to wipe and reseed" >&2
  exit 1
fi

log "clearing target tables"
psql_t -q -c "
  do \$\$ declare t text; begin
    select string_agg(format('%I.%I', schemaname, tablename), ', ') into t
      from pg_tables where schemaname = 'public';
    execute 'truncate ' || t || ', auth.users, auth.identities cascade';
  end \$\$;"

log "restoring database rows"
docker exec -i "$DB" pg_restore -U supabase_admin -d "$DBNAME" --data-only --disable-triggers --single-transaction \
  --no-owner --no-privileges < "$FROM/db.dump"

log "uploading storage objects"
if [ -z "${SEED_SKIP_STORAGE:-}" ]; then
  bun "$ROOT/scripts/seed/storage.ts" push "$FROM/storage.json" "$FROM/storage"
fi

psql_t -q -c "analyze"
log "loaded:"
psql_t -Atc "select 'datasets '||count(*) from datasets union all select 'entries '||count(*) from entries
  union all select 'maps '||count(*) from maps union all select 'apps '||count(*) from apps
  union all select 'users '||count(*) from auth.users"

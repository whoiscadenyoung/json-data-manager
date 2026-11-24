#!/usr/bin/env bash
# Snapshot the grant data from a running stack into a seed directory.
#
#   scripts/seed/export.sh [--out seed-data] [--project "<title or uuid>"]...
#                          [--no-source-files]
#
# Default project: "Traffic Safety Grants". Only that project's datasets,
# layers, maps, apps and versions (plus the accounts they reference) are kept;
# fixtures and scratch data are pruned out of a SCRATCH copy of the database —
# the live db is only read.
#
# Output (gitignored; holds password hashes + ~0.5 GB of files):
#   <out>/db.dump             data-only pg_dump of public + auth.users/identities
#   <out>/storage.json        manifest of kept storage objects
#   <out>/storage/<bucket>/…  the objects themselves
#
# Env (defaults from .env): SEED_DB_CONTAINER=jdm-db, SITE_ORIGIN, SERVICE_ROLE_KEY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/seed-data"
PROJECTS=()
SOURCE_FILES=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --project) PROJECTS+=("$2"); shift 2 ;;
    --no-source-files) SOURCE_FILES=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ ${#PROJECTS[@]} -gt 0 ] || PROJECTS=("Traffic Safety Grants")

set -a; [ -f "${SEED_ENV_FILE:-$ROOT/.env}" ] && . "${SEED_ENV_FILE:-$ROOT/.env}"; set +a
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY not set (source .env or SEED_ENV_FILE)}"
export STORAGE_URL="${STORAGE_URL:-${SITE_ORIGIN:-http://localhost:8000}/storage/v1}"
export SERVICE_ROLE_KEY

DB="${SEED_DB_CONTAINER:-jdm-db}"
SCRATCH="seed_build"
psql_live() { docker exec -i "$DB" psql -U supabase_admin -d app -X -v ON_ERROR_STOP=1 "$@"; }
psql_scratch() { docker exec -i "$DB" psql -U supabase_admin -d "$SCRATCH" -X -v ON_ERROR_STOP=1 "$@"; }
log() { printf '[seed:export] %s\n' "$*"; }

# resolve project titles/uuids -> '{id,id}' array literal
ids=()
for p in "${PROJECTS[@]}"; do
  if [[ "$p" =~ ^[0-9a-f-]{36}$ ]]; then
    ids+=("$p")
  else
    found="$(psql_live -Atc "select id from projects where title = \$q\$${p}\$q\$")"
    [ -n "$found" ] || { echo "no project titled '$p'" >&2; exit 1; }
    while IFS= read -r line; do ids+=("$line"); done <<<"$found"
  fi
done
PROJECT_ARRAY="{$(IFS=,; echo "${ids[*]}")}"
log "projects: $PROJECT_ARRAY"

mkdir -p "$OUT"
rm -rf "$OUT/storage" "$OUT/db.dump" "$OUT/storage.json"

trap 'docker exec "$DB" psql -U supabase_admin -d postgres -X -qc "drop database if exists $SCRATCH" >/dev/null 2>&1 || true' EXIT
docker exec "$DB" psql -U supabase_admin -d postgres -X -qc "drop database if exists $SCRATCH" -c "create database $SCRATCH"

log "copying live db into scratch db $SCRATCH"
# non-fatal restore noise (pg_cron outside its database, auth partitions) is expected
docker exec "$DB" sh -c "pg_dump -U supabase_admin -d app -Fc --no-owner --no-privileges | pg_restore -U supabase_admin -d $SCRATCH --no-owner --no-privileges" \
  >/dev/null 2>"$OUT/.restore.log" || log "pg_restore reported non-fatal errors (see $OUT/.restore.log)"

log "pruning scratch db to the seed set"
psql_scratch -q -v "projects=$PROJECT_ARRAY" < "$ROOT/scripts/seed/prune.sql"

log "dumping data"
docker exec "$DB" pg_dump -U supabase_admin -d "$SCRATCH" -Fc --data-only --no-owner --no-privileges \
  -t 'public.*' -t auth.users -t auth.identities > "$OUT/db.dump"

log "building storage manifest"
EXCLUDE=""
[ "$SOURCE_FILES" = 1 ] || EXCLUDE="and bucket_id <> 'source-files'"
psql_scratch -Atc "
  select coalesce(json_agg(json_build_object('bucket', o.bucket_id, 'name', o.name,
                                             'mimetype', o.metadata->>'mimetype')), '[]')
    from storage.objects o
   where split_part(o.name, '/', 1) in (select id::text from public.datasets)
     ${EXCLUDE//bucket_id/o.bucket_id}" > "$OUT/storage.json"

log "pulling storage objects"
bun "$ROOT/scripts/seed/storage.ts" pull "$OUT/storage.json" "$OUT/storage"

log "counts in snapshot:"
psql_scratch -Atc "select 'datasets '||count(*) from datasets union all select 'entries '||count(*) from entries
  union all select 'maps '||count(*) from maps union all select 'apps '||count(*) from apps
  union all select 'users '||count(*) from auth.users"
log "done -> $OUT"

#!/usr/bin/env bash
# Nightly self-host backup (docs/self-hosting-design.md §10). Runs on the
# VPS host via cron, e.g.:
#   15 4 * * * /srv/jdm/deploy/scripts/backup.sh /srv/jdm >> /srv/jdm/backups/backup.log 2>&1
#
# Produces: backups/app-YYYYmmdd-HHMMSS.dump (pg_dump -Fc of the app
# database) and backups/storage-YYYYmmdd-HHMMSS.tgz (the storage-api file
# volume: source files, tile archives, sprite uploads).
#
# Restore:
#   docker exec -i jdm-db pg_restore -U supabase_admin -d app --clean < backups/app-….dump
#   docker run --rm -v jdm_storage-data:/data -v "$PWD":/backup alpine \
#     sh -c 'cd / && tar xzf /backup/storage-….tgz'
#   docker compose up -d
set -euo pipefail

COMPOSE_DIR="${1:-$(pwd)}"
BACKUP_DIR="${COMPOSE_DIR}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP="${KEEP:-14}"
PROJECT="${COMPOSE_PROJECT_NAME:-jdm}" # compose `name:` in docker-compose.yml

mkdir -p "$BACKUP_DIR"

echo "[backup] dumping ${PROJECT}-db (app) -> app-${STAMP}.dump"
docker exec "${PROJECT}-db" pg_dump -U supabase_admin -d app -Fc \
  > "${BACKUP_DIR}/app-${STAMP}.dump"

echo "[backup] archiving ${PROJECT}-storage-data -> storage-${STAMP}.tgz"
docker run --rm \
  -v "${PROJECT}-storage-data:/data:ro" \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/storage-${STAMP}.tgz" -C / data

# keep the last $KEEP of each kind on disk (off-box copy is the operator's
# habit — rclone/rsync as desired)
ls -1t "${BACKUP_DIR}"/app-*.dump    | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "${BACKUP_DIR}"/storage-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "[backup] done"

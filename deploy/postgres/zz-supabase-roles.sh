#!/bin/bash
# First-boot initdb script for the supabase/postgres image
# (docs/self-hosting-design.md §6). Runs once, on first volume init.
#
# Deliberately named `zz-` so it sorts AFTER the image's own migrate.sh: the
# supabase service roles (authenticator, supabase_auth_admin, …) are created
# by the image's init-scripts, not at initdb — a script that sorts earlier
# runs against zero roles (found the hard way, 2026-11-05).
#
# Pins the service roles to the deployment's POSTGRES_PASSWORD — every
# service DATABASE URL in docker-compose.yml assumes it (CI's store job only
# ever exercised the literal default `postgres`, so the compose deployment
# must make the propagation explicit). It also creates the `_realtime`
# schema the realtime service's DB_AFTER_CONNECT_QUERY points at, mirroring
# the CLI stack's db bootstrap.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=pw="$POSTGRES_PASSWORD" <<-EOSQL
-- Reset whatever roles exist to the deployment password (\gexec tolerates
-- roles this image generation doesn't create).
SELECT format('ALTER ROLE %I WITH PASSWORD %L', rolname, :'pw')
FROM pg_roles
WHERE rolname IN (
  'postgres',
  'authenticator',
  'pgbouncer',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_replication_admin',
  'supabase_read_only_user'
)
\gexec

-- The app's server-side view runner connects as this login role. It becomes a
-- member of `view_runner` when migration 0027 runs (that migration grants it
-- if the role already exists); creating it here keeps the password pinned to
-- POSTGRES_PASSWORD like every other service role.
SELECT format('CREATE ROLE jdm_server LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jdm_server')
\gexec

CREATE SCHEMA IF NOT EXISTS _realtime;
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    EXECUTE 'ALTER SCHEMA _realtime OWNER TO postgres';
  END IF;
END
\$\$;
EOSQL

# supabase/migrations

Numbered SQL migrations for the Postgres backend, applied in filename order:

- **Local:** `supabase db reset` (CLI; config in `../config.toml`) re-runs
  every migration against a fresh local database.
- **CI:** the workflow applies `supabase/migrations/*.sql` in order with
  `psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"` against the
  `supabase/postgres` service container
  (docs/supabase-migration-design.md §12).

Conventions for every migration (design doc §3): schema `public`; `uuid`
primary keys default `gen_random_uuid()`; `timestamptz not null default
now()`; a shared `set_updated_at()` trigger maintains `updated_at` columns.
Third-party extensions install into the `extensions` schema.

- `0001_extensions.sql` — enables `postgis` + `pg_trgm`. `pgcrypto` is not
  needed: `gen_random_uuid()` is core PostgreSQL since 13 and the stack runs
  PostgreSQL 15.

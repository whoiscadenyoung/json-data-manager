-- Stage 0 / 0001 — extensions.
--
-- Enables the extensions the Supabase backend relies on
-- (docs/supabase-migration-design.md §13 stage 0: "extensions postgis/pg_trgm"):
--
--   postgis  — geometry columns (§3: geometries.geom, datasets.bbox) with
--              their GiST indexes, and the entries_in_bbox RPC (§5)
--   pg_trgm  — trigram support behind the search_entries RPC (§8.4)
--
-- Supabase convention installs third-party extensions into the `extensions`
-- schema; keeping it explicit makes local (`supabase start`) and the CI
-- service container (supabase/postgres, §12) behave identically.
--
-- pgcrypto is deliberately NOT enabled here: the schema conventions (§3)
-- use `gen_random_uuid()`, which is core PostgreSQL since 13 and the stack
-- runs PostgreSQL 15 (supabase/config.toml major_version).

create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;

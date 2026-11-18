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
- `0027_views.sql` — Views: `datasets.kind/definition/refresh_mode/output_settings/data_version`,
  `view_inputs`, `view_runs`, the row-write guard, the runner's database half
  (`view_input_versions`; `view_apply_run` / `view_record_failure` executable only by `view_runner`),
  `create_view` / `save_view`, and the `view_stale` computed column (#300).
- `0028_retire_derived.sql` — drops `derived_datasets` and the `derived` project-artifact kind;
  views replace them (#301).
- `0029_views_refresh.sql` — `auto` and `live` refresh modes: `datasets.auto_refresh_by`, the
  `view_refresh_queue` job table + `data_version` trigger, runner-only `set_view_refresh_mode`,
  the drain helpers (`view_refresh_claim` / `_finish` / `_record_failure`), `view_sync_live_meta`;
  `create_view` / `save_view` refuse auto/live; `view_stale` is false for live (#305).
- `0034_project_folders.sql` — catalog folders: `project_folders` (nested, per project, unique
  sibling names, cycle guard), `project_artifacts.folder_id`, member-read / editor-write RLS, and
  `delete_project_folder` (deletes one folder and moves what it holds up a level).
- `0035_links_not_live_views.sql` — a live view cannot be a dataset link end (insert trigger on
  `dataset_relations`) and a linked view cannot be switched to live (trigger on `datasets`).

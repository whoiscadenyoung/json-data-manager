---
name: supabase-stage1-ui-wiring
description: 2026-11-03 stage-1 part B (import pipeline + table on Postgres) —
  the niko-table controlled-menu contract, the scalar-RPC shape, and the
  id-shape split key the later PG stages build on
metadata:
  type: project
---

Learned wiring the stage-1 part B surfaces (create/import flow + entries table
onto `search_entries`/`import_entries`, worktree `jdm-supabase-stage1`):

- **The transitional split keys on the dataset id** (`lib/dataset-source.ts`):
  Postgres rows carry dashed uuids (`gen_random_uuid()`), Convex ids never
  contain dashes — `isPostgresDatasetId(id)` is the ONE predicate every
  surface branches on (`/datasets/$schemaId`, `/$entryId`, and the create
  route without `?projectId=`). The in-project create variant stays Convex
  until stage 4 (projects don't exist in PG yet).
- **niko-table controlled mode** (stage 2's map panels and stage 3's browser
  will need this too): `DataTableRoot` takes `state` + `on*Change` handlers and
  `config.manualSorting/manualFiltering/manualPagination`; the filter menu is
  controlled separately via `filters`/`onFiltersChange` (`filters={[]}` is
  truthy → controlled, so an EMPTY array still skips its internal state), its
  rows are `ExtendedColumnFilter` with `id: Extract<keyof TData, string>` —
  instantiate `DataTableFilterMenu<Record<string, unknown>>` because column
  ids are property names, not keys of the row type. In controlled mode the
  menu NEVER syncs to table state, so mirror `columnFilters` into the table
  state purely for the Reset button's visibility, and honor only the EMPTY
  write from `onColumnFiltersChange`.
- **The §5.1 op set is smaller than the menu's**: text menu offers
  ilike/not.ilike/eq/neq/empty/not.empty but `search_entries` only has
  contains/eq/neq/gt/gte/lt/lte/in — `filtersToSearchFilters` drops the
  counterparts (and OR-join rows are ANDed). Geometry/Created columns opt out
  of sort+filter server-side (no data key → the RPC's `invalid key` guard).
- **Scalar-returning RPCs** (`import_entries` → integer) answer with the bare
  JSON value — `store/client.ts` has `queryScalar` for that shape; `queryRow`
  drops scalars (reads arrays and `.single()` objects only).
- **Storage buckets live in migration 0004** (`geometries`, `source-files`,
  `tile-archives`, `marker-sprites`, all private, authenticated-write
  policies) — Part A's 0002/0003 created none; the import flow's oversized-
  payload and source-file retention paths need them. Uploads are
  browser-direct `storage.upload` with `upsert: true` so a Retry overwrites
  its own leftover paths (`<datasetId>/row-<index>.json`,
  `<datasetId>/<file>`).
- The worktree shares the running stack with `jdm-supabase-backend`
  (`project_id` in config.toml is `jdm-supabase-backend`) — `bunx supabase
migration up` applies pending migrations WITHOUT the destructive
  `db reset`. The worktree has NO `app/.env.local`, so the app can't boot
  from it (env.ts throws) — browser verification of the PG flows still
  needs the operator's env file (§17's values).

Related: [[supabase-stage1-sql-gotchas]], [[supabase-migration-2026-11-03]],
[[ui-polish-expectations]].

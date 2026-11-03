# 15. The backend is rewritten on self-hosted Supabase (Postgres + PostGIS); Convex is retired, not migrated

- Status: accepted
- Date: 2026-11-03
- Companion design (the implementation contract):
  [`../supabase-migration-design.md`](../supabase-migration-design.md)
- Supersedes, for the backend this decision introduces: ADR 0002 (Convex
  component extraction), ADR 0006 (Better Auth hybrid component), ADR 0007
  (the component `exposeApi`/auth-hook contract), and the Convex-storage half
  of ADR 0003 (the tile-archive concept itself carries over). ADR 0009 and
  ADR 0010 are NOT superseded — their authz model is re-expressed in RLS.
  ADR 0005, ADR 0008, ADR 0011–0014 carry over unchanged (the design doc
  lists what each stage ports).

## Context

The app is slow with large datasets, and the cause is the database, not the
frontend. Measured on the isolated local backend with fresh 20k-point data
(2026-10-28/29, `docs/published-map-load-options-2026-10-29.md` and
`docs/map-performance-handoff-2026-10-29.md`):

- A cold open of the dataset page is **16.5 s**, of which ~12 s is the tile
  worker reading geometry rows and ~4 s the archive build. The row read is a
  **per-document database cost: roughly 1 ms per document, linear, and
  parallel queries add no throughput**. Paging, parallelism, and moving the
  code do not remove it — only reading fewer documents does.
- Import is **17.3 s** for 20k rows (down from 48.7 s, #195) — still
  dominated by per-document writes chunked through workflow steps.
- Every search, sort, and filter on the dataset table is **client-side**
  (TanStack Table over fetched rows — `app/src/features/datasets/components/
  entries-table.tsx`), because the component `entries` table carries only a
  `by_schema` index (`packages/json-cms/src/component/schema.ts:329-340`).
  There is no server-side search surface at all, so every table interaction
  pays the full per-document row read.
- The escape hatches were tried: the server-side archive build (#187, phase
  1) was built and measured, then dropped — the V8 action OOMs at its 64 MB
  limit on 20k points and a `"use node"` action made the cold open 28.6 s
  against 16.5 s for the browser worker. The packed-snapshot design
  (`docs/map-geometry-snapshot-design-2026-10-29.md`) was designed and
  shelved.

`docs/postgres-supabase-backend-notes-2026-10-29.md` recorded the
Postgres/Supabase option with a revisit trigger: "the Convex per-document
read cost stays unacceptable on the VPS after the archive-build and snapshot
options are in." That trigger has now fired. `docs/published-map-load-options-2026-10-29.md`
had directed "do not adopt a Postgres rewrite yet"; this decision revises
that direction with the same facts plus the exhausted alternatives. The
preference recorded there — realtime multi-user editing of drafts — stands,
and Supabase Realtime carries it.

## Decision

- **The backend is fully rewritten on Supabase. There is no Convex interop
  and no data migration.** Existing Convex data can be wiped; datasets,
  versions, and accounts are re-created, not converted. A bridge between two
  backends would preserve the per-document costs we are leaving and double
  every surface during the transition.
- **Self-hosted Supabase** (current Postgres + PostGIS) runs in **local
  Docker for now**; the VPS deployment comes later. The whole application
  migrates eventually — stages 0–7 in the design doc end with the Convex
  wiring disconnected from the shell.
- **Repo layout:** a `supabase/` directory at the repo root holds
  `config.toml`, `migrations/*.sql`, and the generated TypeScript DB types,
  committed. Nothing under `app/convex/` or `packages/json-cms/` is touched —
  the Convex code stays in-tree untouched as the reference and revert path.
- **The browser talks PostgREST** via `supabase-js` v2 with `@supabase/ssr`
  (cookie sessions work with TanStack Start SSR). Heavy reads and writes are
  **SQL RPC functions** — `search_entries`, `entries_in_bbox`,
  `import_entries`, `publish_version`, `dataset_rows_for_tiles` — all
  SECURITY INVOKER so RLS applies.
- **Supabase Auth (email/password)** with a `profiles` table
  trigger-maintained from `auth.users`. Sign-up stays closed and accounts
  stay admin-created (the ADR 0009 addendum carries over).
- **RLS mirrors the trusted-collaborator model** (ADR 0009) **plus the edit
  policy** (ADR 0010) through a `can_edit_dataset()` security-definer
  helper; frozen and bound rows keep their absolute read-only guarantee.
- **Realtime** uses `postgres_changes` channels per active dataset feeding
  TanStack Query caches — multi-user editing where it makes sense.
- **Supabase Storage** holds oversized geometry payloads, uploaded marker
  sprites (PNG only, the ADR 0013 rule), and built tile archives.
- **Schema (public):** `datasets` (jsonb schema, trigger-maintained
  `feature_count` and `bbox geometry(Polygon,4326)`, `edit_policy`),
  `entries` (jsonb `data` with GIN `jsonb_path_ops`, trigger-built `search`
  tsvector over the dataset's declared property keys), `geometries` (original
  GeoJSON in `source` jsonb for round-trip fidelity; `geom
  geometry(Geometry,4326)` GENERATED with GiST), `entry_references`
  (trigger-maintained), plus `collections`, `collection_datasets`, `groups`,
  `maps`, `map_layers`, `map_layer_overrides`, `layer_styles`, marker-sprite
  metadata, `imports`, `derived_datasets`, `dataset_versions` +
  `version_entries` (materialized jsonb rows), `tags`, consumption,
  `projects`, `publish_bundles`; late stages add bound-dataset tables and
  app-builder tables. The complete DDL sketch is the design doc's §3.
- **The frontend data layer is rebuilt behind the existing seams:**
  `app/src/integrations/supabase/` (client factory + auth provider),
  per-domain store modules over supabase-js on TanStack Query, and
  `app/src/lib/dataset-rows-pg.ts` mirroring the exported API of the
  row-resolution seam (`app/src/lib/dataset-rows.ts`) with completeness
  semantics preserved. The table view moves to server-side sort/filter/search
  via `search_entries`; column visibility stays client-side.
- **Carried over unchanged:** `@caden/data-core`, `@caden/importers`,
  `@caden/geometry-archive`, `@caden/maps`, `@caden/ui`,
  `@caden/layer-styles`, `@caden/analysis` — they take data and fetchers as
  arguments (ADR 0014), so the tile worker, importers, and analysis engine
  never learn about Supabase.
- **Transitional rule:** from stage 1, new datasets are Postgres-native;
  existing Convex datasets stay frozen until their surface migrates.

## Consequences

- The measured costs move to database-shaped ones: an indexed 20k-row read
  becomes tens of milliseconds instead of ~12 s, imports become set-based
  SQL statements, and sort/filter/search execute server-side against GIN and
  btree indexes. The design doc's verification section pins the A/B recipe
  and targets (row read ~12 s → ~1 s; import 17 s → seconds).
- What Convex gave and Supabase does not (from
  `docs/postgres-supabase-backend-notes-2026-10-29.md`, "What it would not
  give"): no transactional mutations with automatic conflict retry — the
  client merges streamed row changes and conflicts are last-write-wins unless
  versions are checked; `postgres_changes` checks RLS per subscriber, a
  known scaling limit, which is why channels subscribe per active dataset;
  and neither product offers cell-level co-editing (that needs a CRDT either
  way). The map and table surfaces never relied on OCC retries, so the loss
  is bounded; the version machinery (frozen materializations) is where
  consistency is enforced.
- Self-hosting is a Docker stack of roughly ten services against Convex's
  one backend — an operational cost the VPS deployment accepts (the
  migration notes record this trade explicitly).
- Better Auth and the `@convex-dev/better-auth` hybrid (ADR 0006) retire
  with the Convex backend; accounts are re-created in Supabase Auth. ADR
  0007's `exposeApi`/auth-hook contract retires with the component; its
  durable idea — attribution stamped by the authorization layer — becomes
  `created_by` columns filled from `auth.uid()` in RLS-checked writes.
- Versions and publishing re-express on SQL: the frozen row in the component
  `schemas` table becomes `dataset_versions` + `version_entries`
  materializations written by `publish_version()`; derived datasets stay
  virtual registry rows (ADR 0005); tags keep the retire/pin refusal
  (#126) as an FK/trigger check.
- During stages 0–7 the tree carries two backends: untouched Convex code and
  the growing Supabase implementation, switched surface by surface. The
  catalog is deliberately split-brain in the interim (new datasets PG,
  old ones frozen), and the bundle carries both clients until stage 7.
- The revert path is preserved by untouched code: if the migration stalls,
  the Convex app still runs as shipped, and the stage-7 disconnect is one
  wiring seam in the shell.
- Implementation follows `docs/supabase-migration-design.md` — the schema,
  RLS, RPC signatures, stages with acceptance criteria, and the verification
  recipe (including the 20k A/B from `docs/map-performance-handoff-2026-10-29.md`)
  live there, not here.

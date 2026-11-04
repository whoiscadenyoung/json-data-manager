# Supabase/Postgres backend migration — implementation design

- Date: 2026-11-03
- Status: approved plan; the implementation contract for every stage
- Decision record: [`decisions/0015-supabase-postgres-backend.md`](./decisions/0015-supabase-postgres-backend.md)
- Background: `postgres-supabase-backend-notes-2026-10-29.md`,
  `published-map-load-options-2026-10-29.md`,
  `map-performance-handoff-2026-10-29.md`

This document is what every later implementer works from. It fixes the
schema, the RLS model, the RPC signatures, the frontend data-layer layout,
the auth swap, the CI change, the eight stages with acceptance criteria, the
transitional rules, and the verification recipe. Where it names a Convex
table or function, that names the thing being replaced — the Convex code
itself stays in-tree untouched (`app/convex/`, `packages/json-cms/`: no
edits, ever, during this migration).

---

## 1. Goals and non-goals

**Goals**

1. Remove the per-document read cost that dominates large datasets (~1 ms/
   doc, linear, no parallel throughput — 20k rows ≈ 12 s of row read, import
   ≈ 17 s; `published-map-load-options-2026-10-29.md`).
2. Move search/sort/filter server-side (today all client-side over fetched
   rows, because the component `entries` table has only a `by_schema` index,
   `packages/json-cms/src/component/schema.ts:329-340`).
3. Keep realtime multi-user editing where it makes sense (Supabase
   Realtime), per the direction recorded in `published-map-load-options-2026-10-29.md`.
4. Keep every shipped surface: table, maps/tiles, popups, layer styles,
   point markers, catalog, versions/tags, publishing, projects, derived
   datasets, analysis, exports, imports, profiles, app builder, bound
   datasets.
5. Preserve the authz model (ADR 0009 trusted collaborators + ADR 0010 edit
   policy + ADR 0009 addendum signup gating) exactly.

**Non-goals**

- No Convex interop layer, no data migration, no dual reads. Data is
  disposable.
- No cell-level co-editing (needs a CRDT either way — the notes doc records
  this limit for both products).
- No cloud Supabase dependency: everything runs self-hosted (local Docker
  now, VPS later).
- No change to the carried-over workspace packages (§11).

---

## 2. Architecture overview

```
repo root/
  supabase/
    config.toml              # supabase CLI config (local stack; signup disabled)
    migrations/              # numbered .sql migrations (committed)
    seed.sql                 # optional local seed
  app/
    src/integrations/supabase/   # client factory, SSR client, auth provider
    src/lib/store/               # per-domain data modules over supabase-js
    src/lib/dataset-rows-pg.ts   # the row-resolution seam, PG edition
```

Runtime topology (local): the Supabase Docker stack (Postgres 15 + PostGIS,
PostgREST, GoTrue auth, Realtime, Storage, Studio) via `supabase start`;
the browser talks PostgREST with `supabase-js` v2 (REST + RPC + Realtime +
Storage + Auth). TanStack Start SSR reads the session from cookies via
`@supabase/ssr`. No Convex process is needed for any PG-native surface.

Code placement rules (ADR 0014 carry over): only the app imports
`@supabase/supabase-js` / `@supabase/ssr` — never a `@caden/*` package.
`app/src/lib/` stays core; per-domain modules live in `app/src/lib/store/`
and feature code may import them through the core entry (they are seams, not
feature internals).

Environment (`app/src/env.ts`, t3-oss/env-core):

- Add `VITE_SUPABASE_URL` (`z.url()`) and `VITE_SUPABASE_ANON_KEY`
  (`z.string().min(1)`).
- Keep `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` validated until stage 7
  (the Convex provider stays mounted; removing the vars earlier would break
  every still-Convex surface in CI, where `.env.local` does not exist — the
  `stage-3-ci-tree-lessons` memory).

---

## 3. Database schema (DDL sketch)

Conventions for all migrations:

- Schema `public`; `uuid` primary keys default `gen_random_uuid()`;
  `timestamptz not null default now()`; a shared
  `set_updated_at()` trigger maintains `updated_at` where present.
- Attribution columns are `created_by uuid not null default auth.uid()
references public.profiles(id)` — the RLS layer stamps identity (the
  ADR 0007 pattern, SQL edition).
- Foreign keys to user-owned rows cascade; organizational links
  (`group_id`, collection membership) use `set null` / join tables.
- Triggers that maintain denormalized state mirror the component's
  incremental-maintenance rules (`packages/json-cms/src/component/schema.ts:222-242`):
  counts stay exact; the bbox envelope is expand-only (a delete never
  shrinks it) except on explicit clear/conversion.

### 3.1 Stage 0 — profiles

```sql
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  email_verified boolean not null default false,
  name          text,
  image         text,
  created_at    timestamptz not null default now()
);
create index profiles_by_email on public.profiles (email);

-- Trigger-maintained from auth.users (mirrors app/convex/schema.ts:42-50
-- "users", maintained today by the component's user triggers):
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, email_verified, name, image)
  -- confirmed_at, not email_confirmed_at: the pinned CI image
  -- (supabase/postgres 15.8.1.049) carries only confirmed_at; the local
  -- CLI 3.0.0 stack has both. confirmed_at is set whenever GoTrue marks
  -- the account confirmed, so it is the portable signal.
  values (new.id, new.email, coalesce(new.confirmed_at is not null, false),
          new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'avatar_url');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

Profiles expose the ADR 0009 addendum's public projection (authId/name/
image, email only for self): SELECT for all authenticated; UPDATE only
`id = auth.uid()`. The UI renders the signed-in user from one read, as
today.

### 3.2 Stage 1 — datasets, entries, geometries, references, imports

```sql
create table public.datasets (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  description       text,
  json_schema       jsonb not null default '{}'::jsonb,
  -- Declared property keys (array of strings). The search trigger and the
  -- sort/filter key validation in search_entries read THIS column, so a
  -- rogue key can never reach an ORDER BY (the design's injection guard).
  properties        jsonb not null default '[]'::jsonb,
  is_geospatial     boolean not null default false,
  geometry_type     text check (geometry_type in ('Point','MultiPoint',
    'LineString','MultiLineString','Polygon','MultiPolygon','GeometryCollection')),
  -- Summary, trigger-maintained (exact, like featureCount/entryCount in the
  -- component schema):
  entry_count       integer not null default 0,
  feature_count     integer not null default 0,
  -- Expand-only envelope over the dataset's geometries (component schema
  -- lines 222-243 semantics: never shrinks on delete; reset by clear/
  -- conversion). Maintained by geometry triggers.
  bbox              geometry(Polygon,4326),
  max_geometry_row_bytes integer,          -- kept for the paginator port; advisory
  -- Authz (ADR 0010 / stage-8 visibility):
  edit_policy       text not null default 'open'   check (edit_policy in ('open','locked')),
  published_visibility text not null default 'everyone' check (published_visibility in ('everyone','author')),
  lifecycle         text not null default 'published' check (lifecycle in ('draft','published')),
  -- Read-only guarantees: not null lineage = frozen row, absolute read-only
  -- for everyone (ADR 0009), including bound/live freezes (stage 7).
  lineage           jsonb,
  source            jsonb,                   -- bound-dataset marker (stage 7)
  simplify_geometry boolean not null default false,
  -- Source-file retention (import provenance):
  source_file_name  text,
  source_file_size  bigint,
  source_file_path  text,                    -- Storage path
  -- Tile-archive bookkeeping (component schema.ts:262-288 carried over):
  map_tile_cache_version       bigint not null default 0,   -- monotonic, bumped by geometry triggers
  map_tile_archive_path        text,          -- Storage path
  map_tile_archive_bytes       bigint,
  map_tile_archive_max_zoom    integer,
  map_tile_archive_built_version bigint,
  map_tile_archive_format      integer,
  group_id          uuid references public.groups on delete set null,  -- added in stage 3
  created_by        uuid not null default auth.uid() references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index datasets_by_group   on public.datasets (group_id);
create index datasets_by_creator on public.datasets (created_by);
create index datasets_by_lifecycle on public.datasets (lifecycle, published_visibility, created_at desc);
```

```sql
create table public.entries (
  id            uuid primary key default gen_random_uuid(),
  dataset_id    uuid not null references public.datasets on delete cascade,
  data          jsonb not null,
  -- Denormalized copy of the row's geometry type (component parity: enough
  -- for the properties-only table view with zero joins).
  geometry_type text,
  -- Trigger-built full-text vector over the dataset's DECLARED property
  -- keys only (generated columns cannot reference other tables, hence a
  -- trigger). GIN-indexed for search_entries.
  search        tsvector,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index entries_dataset_created on public.entries (dataset_id, created_at desc);
create index entries_data_gin        on public.entries using gin (data jsonb_path_ops);
create index entries_search_gin      on public.entries using gin (search);

-- Search-vector builder: to_tsvector('simple', ...) of data->>key for every
-- key in the owning dataset's declared properties. Rebuilds on INSERT and on
-- UPDATE OF data; also refreshes geometry_type denormalization is done by
-- the geometry trigger (below), not this one.
create function public.entries_build_search() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_keys jsonb;
begin
  select properties into v_keys from public.datasets where id = new.dataset_id;
  select coalesce(string_agg(to_tsvector('simple', new.data->>key)::text, ' '), '')
    into new.search  -- aggregated per key; implementation concatenates vectors
  from jsonb_array_elements_text(v_keys) as key;
  -- (implementation detail: build with tsvector || tsvector over keys)
  return new;
end $$;
create trigger entries_search before insert or update of data on public.entries
  for each row execute function public.entries_build_search();
```

```sql
create table public.geometries (
  id           uuid primary key default gen_random_uuid(),
  dataset_id   uuid not null references public.datasets on delete cascade,
  entry_id     uuid not null unique references public.entries on delete cascade,
  -- The ORIGINAL GeoJSON, kept verbatim for round-trip fidelity (exports
  -- must be byte-faithful to imports, the source-file-retention rule).
  source       jsonb,
  -- Oversized payloads (> INLINE_GEOMETRY_SOURCE_BYTES, §6) live in Storage:
  -- source is null, source_path is set, geom is null, bbox is client-supplied.
  source_path  text,
  source_bytes bigint,
  -- Generated from the verbatim source; typmod enforces SRID 4326.
  geom         geometry(Geometry,4326)
               generated always as (
                 case when source is null then null
                 else st_setsrid(st_geomfromgeojson(source::text), 4326) end
               ) stored,
  bbox         double precision[4],   -- per-geometry [minLon,minLat,maxLon,maxLat]; trigger-filled when geom is not null
  type         text not null,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index geometries_by_dataset on public.geometries (dataset_id);
create index geometries_geom_gist  on public.geometries using gist (geom);
create index geometries_by_type    on public.geometries (dataset_id, type);
```

Dataset-maintenance triggers (one function pair, fired by entries and
geometries writes; they replace `applyEntryCountDelta`,
`bumpMapTileCacheVersion`, and the bbox union in the component):

```sql
-- entries: entry_count ±1 per row; datasets.updated_at touched.
-- geometries: feature_count ±1; bbox := ST_Envelope(ST_Collect(bbox, geom-extent))
--   on insert/replace (expand-only); map_tile_cache_version := map_tile_cache_version + 1
--   on EVERY geometry-affecting write (monotonic, never resets — issue #129 rule);
--   an emptying clear resets feature_count/bbox/max row bytes to 0/null.
-- deleted entries: triggers on ON DELETE CASCADE fire per table; the clear path
--   (import_entries with empty rows / delete_dataset_rows RPC) resets summaries.
```

```sql
create table public.entry_references (
  id                uuid primary key default gen_random_uuid(),
  source_entry_id   uuid not null references public.entries on delete cascade,
  source_dataset_id uuid not null references public.datasets on delete cascade,
  target_entry_id   uuid not null references public.entries on delete cascade,
  target_dataset_id uuid not null references public.datasets on delete cascade,
  field_name        text not null,
  unique (source_entry_id, field_name, target_entry_id)
);
create index entry_refs_by_target_entry  on public.entry_references (target_entry_id);
create index entry_refs_by_source_entry  on public.entry_references (source_entry_id);
create index entry_refs_by_source_dataset on public.entry_references (source_dataset_id);
create index entry_refs_by_target_dataset on public.entry_references (target_dataset_id);

-- Trigger-maintained on entry writes (component `references` parity): on
-- INSERT, and UPDATE OF data, delete this entry's derived rows and re-derive
-- from the reference fields the schema declares (the same detection the
-- client's getReferenceFields does, reading datasets.json_schema); each
-- string value that names an existing entry id becomes one row. Few fields
-- per entry — delete-and-rederive stays cheap, exactly as component
-- entries.ts does it today.
create trigger entry_refs_maintain after insert or update of data or delete on public.entries
  for each row execute function public.entry_refs_sync();
```

```sql
create table public.imports (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references public.datasets on delete cascade,
  status      text not null default 'pending'
              check (status in ('pending','processing','completed','failed')),
  total       integer not null default 0,
  processed   integer not null default 0,
  skipped     integer not null default 0,
  error       text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index imports_by_dataset on public.imports (dataset_id, created_at desc);
```

The import workflow's chunk-completion journal (issue #129 durability) is
not needed in this shape: each `import_entries` call is one SQL statement —
atomic by itself — and the `imports` row's `processed` is updated per call
by the same statement.

### 3.3 Stage 2 additions — storage columns only

No new tables. `map_tile_archive_*` columns and the `tile-archives` /
`geometries` / `marker-sprites` buckets exist from §3.2/§6; stage 2 starts
using them. The archive install is an RPC compare-and-set (§5.6) mirroring
`setMapTileArchive`'s `expectedVersion` guard — the correctness mechanism
from issue #129/#58 carries unchanged.

### 3.4 Stage 3 — catalog (collections, groups, maps, layers, styles, sprites)

```sql
create table public.collections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.collection_datasets (
  collection_id uuid not null references public.collections on delete cascade,
  dataset_id    uuid not null references public.datasets on delete cascade,
  kind          text check (kind in ('standard','geospatial')),  -- denormalized from datasets (component parity)
  primary key (collection_id, dataset_id)
);
create index collection_datasets_by_dataset on public.collection_datasets (dataset_id);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid references public.collections on delete set null,  -- may float standalone (component parity)
  name text not null,
  description text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index groups_by_collection on public.groups (collection_id);

create table public.maps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.map_layers (
  id          uuid primary key default gen_random_uuid(),
  map_id      uuid not null references public.maps on delete cascade,
  order       integer not null,                       -- draw/list position; written contiguously, gaps allowed after removal
  target_type text not null check (target_type in ('collection','group','dataset','derived')),
  target_id   text not null,                          -- uuid as text; 'derived' holds a derived_datasets id (component parity incl. dangling-target tolerance)
  visible     boolean not null default true
);
create index map_layers_by_map   on public.map_layers (map_id, "order");
create index map_layers_by_target on public.map_layers (target_id);

create table public.map_layer_overrides (
  id        uuid primary key default gen_random_uuid(),
  layer_id  uuid not null references public.map_layers on delete cascade,
  child_key text not null,                            -- 'group:<id>' | 'dataset:<id>' (component parity)
  visible   boolean not null,
  unique (layer_id, child_key)
);

create table public.layer_styles (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps on delete cascade,
  render_id  text not null,                           -- the dataset/derived id the map renders under (ADR 0012)
  style      jsonb not null,                          -- MapLibre style-spec fragment
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  unique (map_id, render_id)
);

create table public.marker_sprites (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  storage_path text not null unique,                  -- marker-sprites bucket, PNG only (ADR 0013)
  sdf          boolean not null default false,
  width        integer not null,
  height       integer not null,
  pixel_ratio  double precision not null default 1,
  uploaded_by  uuid not null references public.profiles(id),
  uploaded_at  timestamptz not null default now()
);
create index marker_sprites_by_uploaded on public.marker_sprites (uploaded_at desc);
```

Deleted-with-parent cascades replace the component's explicit
deleteSchema/deleteGroup/deleteCollection cleanup walks.

### 3.5 Stage 4 — versions, tags, consumption, projects, bundles

```sql
create table public.derived_datasets (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,                    -- only required field (UI rule)
  description       text,
  spec              jsonb not null,                   -- serializable TransformSpec, shapeless (component parity: never a per-op validator)
  source_dataset_id uuid references public.datasets on delete cascade,
  source_derived_id uuid references public.derived_datasets on delete cascade,  -- derived-of-derived (DAG)
  depends_on        text[] not null default '{}',     -- denormalized edges for the save-time cycle walk (component parity)
  status            text not null default 'draft' check (status in ('draft','saved')),
  created_by        uuid not null default auth.uid() references public.profiles(id),
  created_at        timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (num_non_nulls(source_dataset_id, source_derived_id) = 1)
);
create index derived_by_status_source on public.derived_datasets (status, coalesce(source_dataset_id, source_derived_id));
create index derived_by_source_creator on public.derived_datasets (coalesce(source_dataset_id, source_derived_id), created_by);
-- Analyses are rows here too (sql op kind) — no separate analysis table
-- (the stage-9 precedent: an analysis is a registry row).

create table public.dataset_versions (
  id            uuid primary key default gen_random_uuid(),
  dataset_id    uuid not null references public.datasets on delete cascade,
  ref           text not null unique,                 -- the durable version identity ("a ref never freezes twice")
  publish_key   text unique,                          -- idempotency key (retried publish cannot fork two v1s)
  version_label text not null,
  lineage       jsonb not null,                       -- recipe + source versions (lineageValidator shape, component schema.ts:33-49)
  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index versions_by_dataset on public.dataset_versions (dataset_id, created_at desc);

-- Materialized jsonb rows frozen at publish time (replaces the frozen
-- component schemas row + its re-imported entries). Immutable by
-- construction: NO table grants INSERT/UPDATE/DELETE to anyone but the
-- publish_version() RPC owner path — not even RLS-permissive writers.
create table public.version_entries (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references public.dataset_versions on delete cascade,
  entry_id      uuid references public.entries on delete set null,  -- origin (provenance only; the jsonb row is the truth)
  data          jsonb not null,
  geometry      jsonb,                                -- verbatim GeoJSON at freeze time
  geometry_type text,
  bbox          double precision[4],
  ordinal       bigint not null
);
create index version_entries_by_version on public.version_entries (version_id, ordinal);

create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets on delete cascade,
  name       text not null,
  version_id uuid not null references public.dataset_versions on delete restrict,  -- the pin, as FK
  retired_at timestamptz,                            -- null = live; retiring nulls the pin (check below)
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (dataset_id, name)
);
-- Retire-version pin refusal (#126) as a trigger: refusing to retire (or
-- delete) a version that any consumer_references row pins — the manual path
-- can never leave a pinned consumer dangling.
create function public.tags_guard_retire() returns trigger ... -- raises when
  -- old.version_id is pinned by consumption AND retired_at is being set;
  -- delete trigger raises when the version is pinned.

create table public.consumer_references (            -- "consumption"
  id                uuid primary key default gen_random_uuid(),
  consumer_id       text not null,                    -- derived_datasets id / map-layer leg / membership row (component parity, text id space)
  consumer_kind     text not null check (consumer_kind in ('derived','map','fork')),
  source_dataset_id uuid references public.datasets on delete cascade,
  mode              text not null default 'float' check (mode in ('float','pin')),
  pinned_version_id uuid references public.dataset_versions on delete restrict,
  pinned_ref        text,
  created_at        timestamptz not null default now()
);
create index consumer_refs_by_consumer on public.consumer_references (consumer_id);
create index consumer_refs_by_source   on public.consumer_references (source_dataset_id);
create index consumer_refs_by_pin      on public.consumer_references (pinned_version_id);

create table public.version_policies (               -- keep-N / pinned refs per chain anchor
  dataset_key  text primary key,                     -- chain anchor id (dataset or derived row), component parity
  keep_versions integer,
  pinned_refs  text[] not null default '{}'
);

create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text,
  artifact_count integer not null default 0,         -- denormalized, lockstep with artifacts (component parity)
  created_by     uuid not null default auth.uid() references public.profiles(id),
  created_at     timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index projects_by_creator on public.projects (created_by);
-- NOTE: projects are per-creator PRIVATE (stage-8 ownership, #104) — the one
-- shared-artifact exception; RLS is creator-only (§4).

create table public.project_artifacts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects on delete cascade,
  artifact_id  text not null,
  artifact_kind text not null check (artifact_kind in ('dataset','derived','map')),
  added_by     uuid not null references public.profiles(id),
  unique (project_id, artifact_kind, artifact_id)
);
create index project_artifacts_by_artifact on public.project_artifacts (artifact_kind, artifact_id);

create table public.publish_bundles (                -- bundle press runs (component bundleRuns)
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects on delete cascade,
  title          text not null,
  project_description text,
  collection_id  uuid references public.collections on delete set null,  -- created once, reused across presses
  status         text not null default 'running' check (status in ('running','completed','failed')),
  error          text,
  created_by     uuid not null references public.profiles(id),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  last_progress_at timestamptz not null default now()
);
create index bundles_by_project on public.publish_bundles (project_id, started_at desc);

create table public.publish_bundle_members (         -- component bundleRunMembers
  id                   uuid primary key default gen_random_uuid(),
  bundle_id            uuid not null references public.publish_bundles on delete cascade,
  kind                 text not null check (kind in ('dataset','derived','map')),
  dataset_key          text not null,
  group_id             uuid,
  publish              boolean not null default true,
  status               text not null default 'pending' check (status in
                       ('pending','publishing','published','referenced','linked','failed')),
  published_version_id uuid references public.dataset_versions on delete set null,
  attempt_id           uuid,
  layer_targets        text[],
  error                text
);
create index bundle_members_by_bundle on public.publish_bundle_members (bundle_id);
```

(Publish _attempts_ — the per-member publish durability row, component
`publishAttempts` — collapse into `publish_bundle_members.attempt_id` plus
`imports`-style progress on the version RPC; stage 4 details the
chunk-resume port, reusing the import pipeline of §10.)

### 3.6 Stage 7 — bound datasets + app builder

```sql
create table public.remote_sources (                 -- source registry + manifest checks (sources/registry.ts, remoteSourceChecks)
  source text primary key,
  checked_at timestamptz,
  error text,
  layer jsonb,                                       -- last successful manifest read
  record_url_template text
);

create table public.dataset_bindings (               -- sources/tables.ts datasetBindings
  id uuid primary key default gen_random_uuid(),
  source text not null references public.remote_sources(source),
  dataset_id uuid not null references public.datasets on delete cascade,
  schema_mapping jsonb,
  last_applied_commit_id text,
  last_applied_commit_seq bigint,
  last_synced_at timestamptz,
  last_reconciled_at timestamptz,
  keep_versions integer,
  pinned_refs text[] not null default '{}',
  source_updated_at timestamptz,
  synced_entry_count integer,
  remote_revision bigint,
  remote_schema_version text,
  created_at timestamptz not null default now()
);
create index bindings_by_source on public.dataset_bindings (source);

create table public.binding_entries (                -- the idempotency key map
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.dataset_bindings on delete cascade,
  entry_key  text not null,
  entry_id   uuid not null references public.entries on delete cascade,
  seen_run   text,
  unique (binding_id, entry_key)
);

create table public.sync_runs (                      -- the durable sync engine rows
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.dataset_bindings on delete cascade,
  mode text not null check (mode in ('commit-tail','reconcile','sync')),
  status text not null check (status in ('collecting','applying','sweeping','completed','failed')),
  total integer not null default 0,
  added integer not null default 0, updated integer not null default 0, removed integer not null default 0,
  applied integer not null default 0,
  chunk_index integer not null default 0, row_offset integer not null default 0,
  collect_attempts integer, claim text,
  needs_reconcile boolean,
  last_commit_id text, last_seq bigint, remote_revision bigint,
  ops jsonb not null default '[]',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz, last_progress_at timestamptz not null default now(),
  truncated boolean not null default false
);
create index sync_runs_by_binding on public.sync_runs (binding_id, started_at desc);
-- Chunk blobs ride Storage (chunk paths recorded on the run row) instead of
-- Convex _storage ids.

create table public.commit_mirror (                  -- applied-commit mirror (commits)
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.dataset_bindings on delete cascade,
  foreign_commit_id text not null,
  seq bigint not null,
  message text not null,
  ops jsonb not null default '[]',
  at timestamptz not null,
  applied_at timestamptz not null default now(),
  unique (binding_id, foreign_commit_id)
);
create index commit_mirror_by_binding_seq on public.commit_mirror (binding_id, seq desc);

create table public.dataset_activity (               -- the History-tab feed (cms/tables.ts)
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.dataset_bindings on delete cascade,
  kind text check (kind in ('sync','reconcile')),
  added integer not null default 0, updated integer not null default 0, removed integer not null default 0,
  entry_count integer not null default 0,
  ops jsonb not null default '[]',
  needs_reconcile boolean,
  synced_at timestamptz not null,
  truncated boolean
);
create index dataset_activity_by_binding on public.dataset_activity (binding_id, synced_at desc);

create table public.apps (                           -- app builder (appBuilder/tables.ts)
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  sharing jsonb not null,
  dataset_ids uuid[] not null default '{}',          -- data refs only (apps store dataset refs)
  pages jsonb,                                       -- inline bounded layout (component parity)
  example boolean,
  revision integer not null default 0,               -- optimistic-concurrency counter for saveContent
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index apps_by_creator on public.apps (created_by);
create index apps_by_example on public.apps (example);
```

**Not carried:** the `demoSources` tables (the demo foreign app — demo-only
per ADR 0014; its projection target becomes an ordinary PG table created
alongside stage 7 if the demo is rebuilt) and `pendingUploads` (Supabase
Storage signed upload URLs are server-issued and self-proving). `tagDeltas`
is stage 7 (bound-tag history) and ports as `commit_mirror` rows consumed by
the compare view, which computes arbitrary pairs on demand (component
parity).

---

## 4. Row-level security

Two SECURITY DEFINER helpers (definer + pinned `search_path` because RLS
policies on `datasets` itself must call them without recursing; STABLE so
they can appear in USING clauses):

```sql
-- Who may READ a dataset: drafts are private to their creator;
-- publishedVisibility 'author' restricts reads to the creator; everything
-- else is readable by any signed-in user (ADR 0009 + stage-8 model).
create function public.can_view_dataset(p_dataset uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset
      and auth.uid() is not null
      and (d.lifecycle is distinct from 'draft' or d.created_by = auth.uid())
      and (d.published_visibility is distinct from 'author' or d.created_by = auth.uid())
  );
$$;

-- Who may WRITE a dataset (every write — data, schema, imports, edits):
-- authenticated; never a frozen row (lineage not null = absolute read-only
-- for everyone, ADR 0009); 'open' = any signed-in user (trusted
-- collaborator); 'locked' = creator only (ADR 0010, no carve-outs).
create function public.can_edit_dataset(p_dataset uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset
      and auth.uid() is not null
      and d.lineage is null
      and (d.edit_policy = 'open' or d.created_by = auth.uid())
  );
$$;
```

Denial shape follows ADR 0010: an invisible row reads as "not found" (RLS
filters it; the UI never learns it exists), and a lock denial leaks nothing
(existence of a published row is already public). Reads never consult
`edit_policy`; writes never consult `published_visibility` — the two compose
into the four combinations exactly as the ADR requires.

**Policy matrix** (all `TO authenticated`; the `anon` role gets nothing):

| Table                                                                                         | SELECT                                                                                  | INSERT / UPDATE / DELETE                                                                                                   |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| profiles                                                                                      | authenticated (public projection; self sees email)                                      | UPDATE self only                                                                                                           |
| datasets                                                                                      | `can_view_dataset(id)`                                                                  | `can_edit_dataset(id)` (UPDATE also re-checks it — flipping `edit_policy` is itself a gated write, the setEditPolicy rule) |
| entries                                                                                       | `can_view_dataset(dataset_id)`                                                          | `can_edit_dataset(dataset_id)`                                                                                             |
| geometries                                                                                    | `can_view_dataset(dataset_id)`                                                          | `can_edit_dataset(dataset_id)`                                                                                             |
| entry_references                                                                              | viewable when either side is viewable                                                   | write only through entry writes (trigger-owned; no direct grant)                                                           |
| imports                                                                                       | `can_view_dataset(dataset_id)`                                                          | `can_edit_dataset(dataset_id)`                                                                                             |
| collections, groups, maps, map_layers, map_layer_overrides, layer_styles, marker_sprites      | authenticated (shared catalog artifacts — ADR 0009, maps stay open)                     | authenticated                                                                                                              |
| collection_datasets                                                                           | authenticated                                                                           | authenticated                                                                                                              |
| derived_datasets                                                                              | authenticated (drafts invisible to consumers by the status column, component parity)    | authenticated; UPDATE may not change `created_by`                                                                          |
| dataset_versions, version_entries                                                             | `can_view_dataset(dataset_id)` / via version join                                       | NO direct grants — written only by `publish_version()` (owner/definer path); immutable                                     |
| tags                                                                                          | authenticated                                                                           | authenticated + retire guard trigger                                                                                       |
| consumer_references, version_policies                                                         | authenticated                                                                           | authenticated                                                                                                              |
| projects, project_artifacts                                                                   | creator only (`created_by = auth.uid()`) — the stage-8 private exception                | creator only                                                                                                               |
| publish_bundles (+ members)                                                                   | creator only (they are project state)                                                   | creator only                                                                                                               |
| remote_sources, dataset_bindings, binding_entries, sync_runs, commit_mirror, dataset_activity | authenticated (read)                                                                    | sync engine only (service_role / definer RPCs); bindings' CRUD via can_edit_dataset of the bound dataset                   |
| apps                                                                                          | sharing per row (`sharing` jsonb: creator-edit; examples readable by all authenticated) | creator only (`created_by`), seeded examples excepted                                                                      |

Trigger-maintained columns (`entry_count`, `feature_count`, `bbox`,
`map_tile_cache_version`, `search`, `entry_references`) are updated by
SECURITY DEFINER trigger functions, so the client never needs the direct
UPDATE right on maintained columns — but dataset UPDATE remains available
for real fields, gated by `can_edit_dataset`.

`security invoker` is the default for every RPC; only the two helpers above
are definer. Realtime (`postgres_changes`) runs RLS per subscriber — the
channel design in §7 respects it and the known scaling limit.

---

## 5. RPC API (exact signatures)

All SECURITY INVOKER (RLS applies inside them). Keyset cursors are opaque
base64 of the sort tuple + id; every RPC that pages returns `next_cursor`
(null = exhausted — the `isDone` analogue the seam requires).

### 5.1 search_entries — server-side table sort/filter/search

```sql
create function public.search_entries(
  p_dataset uuid,
  p_query   text   default null,   -- websearch syntax; null/'' = no search filter
  p_filters jsonb  default null,   -- array of {key, op, value}; op in ('eq','neq','contains','gt','gte','lt','lte','in'); jsonb containment per eq
  p_sort    jsonb  default null,   -- {key, dir: 'asc'|'desc'}; null = created_at desc (the table default)
  p_cursor  text   default null,
  p_limit   integer default 200
)
returns table (
  id            uuid,
  data          jsonb,
  geometry_type text,
  created_at    timestamptz,
  next_cursor   text
)
```

Semantics (each is a hard requirement):

- **Key validation before use.** Every `sort.key` and `filters[].key` is
  checked against the dataset's declared `properties` and raises
  `invalid key` otherwise — user input never becomes SQL. Values bind as
  parameters.
- **Search:** `search @@ websearch_to_tsquery('simple', p_query)` over the
  trigger-built vector (GIN).
- **Filter ops:** `eq` uses `data @> jsonb_build_object(key, value)`
  (jsonb_path_ops GIN); ranges/`in` use `data->>key` comparisons.
- **Sort:** `order by data->>sort.key asc/desc, id desc` (stable id
  tiebreak); default `created_at desc, id desc` (the btree
  `(dataset_id, created_at desc)` serves it).
- **Keyset pagination:** cursor carries the last row's sort tuple + id; the
  WHERE clause re-derives "strictly after" with a row comparison — no
  OFFSET, stable under inserts.
- Returns `p_limit + 1` rows internally; `next_cursor` null when exhausted
  (completeness semantics, §8.3).

### 5.2 entries_in_bbox — viewport reads

```sql
create function public.entries_in_bbox(
  p_dataset uuid,
  p_bbox    jsonb    -- [minLon, minLat, maxLon, maxLat]
)
returns table (
  id uuid, data jsonb, geometry jsonb, geometry_type text, bbox double precision[]
)
```

`geom && ST_MakeEnvelope(...)` (GiST) joined to entries; skips
storage-backed rows (`geom is null`), which viewport reads fetch separately
from Storage URLs exactly like today's `geometryUrl` path
(`app/src/lib/dataset-rows.ts:461-496`).

### 5.3 import_entries — set-based import

```sql
create function public.import_entries(
  p_dataset uuid,
  p_rows    jsonb     -- [{data, geometry?, geometryType?, geometrySourcePath?}]
)
returns integer            -- rows inserted
```

One statement per call: `jsonb_to_recordset(p_rows) as x(data jsonb,
geometry jsonb, geometry_type text)` → INSERT into `entries` (row_number
correlates payload rows to the returning ids) → INSERT into `geometries`
(source, type, client-supplied bbox for storage-backed rows). Dataset
summaries and search vectors are maintained by the triggers. The client
chunks ~1–2 MB per call after `@caden/importers` parses (the Convex
action-size budgets do not apply; this bound is purely HTTP-shaped).
Checking `can_edit_dataset` is implicit via RLS; the function additionally
bumps `imports.processed` for progress reporting.

### 5.4 publish_version — frozen materialization

```sql
create function public.publish_version(
  p_dataset       uuid,
  p_version_label text,
  p_publish_key   text,     -- idempotency key
  p_lineage       jsonb default null
)
returns uuid               -- dataset_versions.id
```

Set-based, one transaction: INSERT the `dataset_versions` row (`ON CONFLICT
(publish_key) DO NOTHING` + re-select — a retried/killed publish cannot fork
two v1s, the publishKey rule), then
`insert into version_entries (...) select ... from entries left join
geometries ... where dataset_id = p_dataset` — the materialized jsonb rows.
`lineage` records recipe + source versions (the `lineageValidator` shape).
No direct grants exist on the version tables (§4), so frozen rows are
immutable by construction. Publishing a `locked` dataset requires its
creator (RLS answers before the RPC body runs).

### 5.5 dataset_rows_for_tiles — the tile worker's feed

```sql
create function public.dataset_rows_for_tiles(
  p_dataset uuid,
  p_cursor  text    default null,
  p_limit   integer default 5000
)
returns table (
  entry_id uuid, data jsonb, geometry jsonb, geometry_source_path text,
  geometry_type text, bbox double precision[]
)
```

Keyset by entry id; the app feeds pages to the unchanged
`@caden/geometry-archive` worker (§11). Replaces `geometries.list` + the
12 s row read with indexed scans.

### 5.6 install_tile_archive — compare-and-set install

```sql
create function public.install_tile_archive(
  p_dataset uuid, p_expected_version bigint,
  p_path text, p_bytes bigint, p_max_zoom integer, p_built_version bigint, p_format integer
)
returns boolean   -- false when p_expected_version <> current map_tile_cache_version (stale rebuild detected)
```

The `setMapTileArchive expectedVersion` guard, SQL edition (issue #129/#58
correctness). Storage upload happens first via a signed URL; the RPC claims
it.

---

## 6. Storage

| Bucket           | Contents                                                                                                                                   | Access                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `geometries`     | Oversized geometry `source` payloads (above `INLINE_GEOMETRY_SOURCE_BYTES`, set at 256 KB — the Convex INLINE_GEOMETRY_BYTE_LIMIT concept) | private; reads via short-lived signed URLs (the `fetchGeometryPayload` path) |
| `marker-sprites` | Uploaded point-marker icons — PNG only, rasterized in the uploader's browser; SVG is never stored or served (ADR 0013)                     | private, signed reads                                                        |
| `tile-archives`  | Built PMTiles archives (`install_tile_archive` claims them)                                                                                | private, range-read signed URLs (the OPFS pin + range requests carry over)   |
| `source-files`   | Original import files (`source_file_*` retention)                                                                                          | private                                                                      |

Uploads: browser requests a signed URL, PUTs the bytes, then writes the
row/RPC (the pendingUploads provenance problem disappears — signed URLs are
server-issued and single-purpose).

---

## 7. Realtime design

- One channel per **active** dataset (the dataset page or a map layer's
  dataset), subscribed on mount, unsubscribed on unmount:
  `supabase.channel('dataset:<id>')` with `postgres_changes` events for
  `entries` / `geometries` filtered `dataset_id=eq.<id>`.
- Events patch the TanStack Query caches (`queryClient.setQueryData` for the
  affected keys, invalidate for summaries) — the reactive-fill behavior
  `useQuery` gives today, minus Convex's re-run.
- Conflicts: last-write-wins at the row level; the version machinery
  (frozen materializations) is where consistency is enforced. The notes
  doc's honest limit stands: no OCC retry, no cell co-editing.
- RLS applies per subscriber (Realtime checks policies) — which is also the
  known scaling limit; per-active-dataset granularity (never app-wide
  subscriptions) is the mitigation.
- The tile-manager live signal (`mapTileCacheVersion`) becomes one realtime
  subscription on the dataset row — the #186 remainder's "single live
  signal", for free.

---

## 8. Frontend data layer

### 8.1 Layout

```
app/src/integrations/supabase/
  client.ts      # createBrowserClient (browser singleton; RLS-scoped anon key)
  server.ts      # createServerClient from request cookies (TanStack Start SSR/server fns)
  provider.tsx   # SupabaseAuthProvider: session context + onAuthStateChange -> queryClient invalidation
  types.ts       # generated Database types, COMMITTED (supabase gen types typescript --local)
app/src/lib/
  auth-client.ts # rewritten over supabase-js auth (signInWithPassword, signOut, onAuthStateChange)
  store/         # per-domain modules, each mirroring today's api.* names:
    datasets.ts    # api.cms.schemas.* / api.cms.entries.* summary reads -> list/get/create/update/setEditPolicy/...
    entries.ts     # listPage/listForIds/get/create/update/delete + searchEntries (search_entries RPC)
    geometries.ts  # list/getByEntry/create/replace/delete + rowsForTiles paging
    references.ts  # reverse lookup reads
    imports.ts     # start/chunk/complete over import_entries
    catalog.ts     # collections/groups/membership (api.cms.collections|groups|maps equivalents live in maps.ts)
    maps.ts        # maps/mapLayers/overrides CRUD
    styles.ts      # layerStyles + markerSprites
    versions.ts    # datasetVersions/tags/policies/consumerReferences
    publishing.ts  # publish_version orchestration + bundles
    derived.ts     # derivedDatasets registry CRUD + status
    projects.ts    # projects/artifacts
    analysis.ts    # analyses (= derived rows, sql kind) + DuckDB handoff unchanged
    bindings.ts    # stage 7
    apps.ts        # stage 7
    profiles.ts    # self/profile reads
```

Each module exports functions with the shape of today's `api.*` calls
(argument objects in, plain rows out) so feature code changes call sites,
not logic. Every read is a TanStack Query (`queryOptions` per function);
every write is a mutation that invalidates by query key.

### 8.2 Persister / light-namespace conventions

The TanStack Query persister and the `light-namespaces` allowlist survive
with renamed namespaces (`pg:datasets`, `pg:entries`, …) — query hashes
carry the namespace name, so **`PERSIST_KEY` bumps to `light-query-cache-v3`
when the store namespaces replace the convex ones** (the convex-domain-
folders memory rule). AsyncStorage contracts (`setItem(key,value)`,
idempotent connect, `onSuccess` initial save, defined buster) are already
encoded in the provider; only the key strings change.

### 8.3 dataset-rows-pg.ts — the row-resolution seam, PG edition

`app/src/lib/dataset-rows-pg.ts` mirrors the exported API of
`app/src/lib/dataset-rows.ts` (read in full; it is the contract):

- Types `DatasetEntryRow`, `DatasetGeometryRow`; constants
  `ENTRIES_PAGE_SIZE` / `ENTRIES_FETCH_PAGE_SIZE` / `GEOMETRY_PAGE_ROWS` —
  **page sizes may rise** (e.g. 500/2000) because the Convex byte budgets
  (`GEOMETRY_PAGE_BYTE_BUDGET`, the 16 MiB execution cap, the 8192-element
  array cap that forced JSON-encoded geometry) do not exist in Postgres.
- `forEachDatasetEntryPage` / `fetchDatasetEntryRows` /
  `forEachDatasetGeometryPage` / `fetchDatasetGeometryRows` /
  `resolveDatasetGeometryRows` / `resolveGeometryRows` — cursor-chained to
  **exhaustion**; `next_cursor === null` is `isDone` (completeness
  semantics preserved: `status === "Exhausted"` + all rows resolved, the
  ui-polish rule). Storage-backed geometry rows resolve via signed URLs
  exactly as `resolveGeometryRows` does today.
- `entryDataRecord`, `lookupOperationsOfSpec`, `applyEntryRowSpecs`,
  `applyEntryRowSpec`, `applyGeometryRowSpecs`, `applyGeometryRowSpec` —
  copied **unchanged** (pure functions over row shapes; the popup executor's
  semantics are pinned by `dataset-rows.test.ts` and must not drift).
- `sharedClient()` becomes the shared supabase browser client (auth
  attaches via the provider's session; no token-fetch pause dance — cookies
  ride every request). The tile worker passes its own client instance, same
  seam.
- The reactive hooks (`dataset-rows-react.tsx`) keep their shape; their
  data source swaps to the store modules. The spec-application step stays
  INSIDE these functions — no consumer paginates on its own.

### 8.4 Table view — server-side sort/filter/search

`entries-table.tsx` keeps niko-table (TanStack Table v9) but flips to
manual mode for the server concerns:

- `DataTableSearchFilter` / `DataTableFilterMenu` /
  `DataTableColumnHeader` sort controls hoist their state into
  `{query, filters, sort}` → one `useQuery(store.entries.searchEntries(
{datasetId, query, filters, sort, cursor}))` per state (keyset pages
  accumulate for the virtualized body + load-more).
- Column visibility stays **client-side** (`DataTableViewMenu` untouched).
- Reference-label lookup (`listForIds`) stays as-is, now a PostgREST `in`
  query on the exact referenced ids.
- Empty/loading states: skeleton gate rides completeness (§8.3), never
  `isLoading` (ui-polish memory).

---

## 9. Auth swap (@supabase/ssr × TanStack Start)

- **Session transport: cookies.** `@supabase/ssr` stores the session in
  cookies so TanStack Start's server functions/SSR can create a
  `createServerClient` per request (`integrations/supabase/server.ts`) —
  RLS-authorized reads work during SSR, which today renders spinners only.
- **Provider:** `SupabaseAuthProvider` (integrations/supabase/provider.tsx)
  exposes `{session, isLoading}` and subscribes to `onAuthStateChange`.
  `integrations/convex/provider.tsx` STAYS MOUNTED until stage 7 — both
  auth halves coexist; `useConvexAuth` keeps answering for Convex surfaces
  while the new `useSession` answers for PG surfaces.
- **Rewired at stage 0:** `components/auth-gate.tsx`, `components/header.tsx`
  (user chip from the GoTrue user metadata at stage 0; a profiles read
  replaces it when the store modules land, §3.1/§8.1), `routes/signin.tsx`
  (same busy-state/redirect/safeRedirect semantics), and sign-out in
  `components/header.tsx` (below).
- **Stage-0 session bridge (review-mandated).** The still-mounted Convex
  provider is fed SOLELY by its Better Auth session
  (`ConvexBetterAuthProvider authClient`), and `app/convex/auth.ts` rejects
  unauthenticated callers on every exposed read AND write — so a sign-in
  that wrote only a Supabase session would open the gate over a fully
  unauthenticated Convex backend (the endless-skeleton failure mode #135
  built the gate to prevent). Stage 0 is therefore a two-session world:
  - `routes/signin.tsx` signs the same credentials into BOTH stores —
    `supabase.auth.signInWithPassword` first, then the bridge
    `authClient.signIn.email` for the Better Auth session. If the bridge
    half fails, the Supabase half is rolled back (`signOut`) so neither
    session is left live, and the reason is surfaced — the usual cause is
    an account minted on only one side.
  - `components/auth-gate.tsx` opens only when BOTH halves resolved
    signed-in (`useSession` session AND `useConvexAuth` authenticated);
    the spinner/redirect shape is unchanged. The routed tree still queries
    only Convex at stage 0, so the Convex half is load-bearing; the
    Supabase half must also be up or the PG surfaces (stage 1+) and the
    header chip would hang half-signed-in. `/signin` auto-redirects only
    on both, so a half-signed-in visitor cannot loop.
  - Sign-out ends both sessions (`supabase.auth.signOut()` +
    `authClient.signOut()`), so no legacy Better Auth cookie outlives it.
- **Signup gating carries (ADR 0009 addendum):** Supabase Auth has "Disable
  new user signups" enabled (`config.toml` / dashboard) — the public surface
  is sign-in only; accounts are admin-created by the operator AS A PAIR with
  matching credentials (the bridge signs the same email/password into both):
  the Supabase user via the service-role key (`auth.admin.createUser` with
  `email_confirm: true` — local recipe: `supabase admin create-user` or a
  Dashboard action) AND the Better Auth account via
  `bunx convex run auth:createAccount '{"email": …, "password": …, "name":
…}'` (local backend: add `--url http://127.0.0.1:3212 --admin-key …`;
  password ≥ 8 chars, app/convex/auth.ts). The design keeps the
  "ask the maintainer for an account" UX copy.
- **Token plumbing retired:** `lib/convex-auth-token.ts` and the
  Better-Auth→Convex JWT feed die at stage 7; until then they serve only
  the still-mounted Convex half.

---

## 10. Import pipeline (stage 1)

1. Client parses the file with `@caden/importers` (unchanged) and, for
   geospatial files, splits rows into `{data, geometry}` pairs.
2. Oversized geometry payloads (> 256 KB source) PUT to `geometries/`
   storage first; rows then carry `geometrySourcePath`.
3. `import_entries(dataset, rows)` per ~1–2 MB chunk (sequential, progress
   per chunk into the `imports` row) — one SQL statement per chunk.
   Target: a 20k-point import lands in seconds (§15).
4. The dataset's source file uploads to `source-files/` for retention.
5. Tile-archive scheduling is unchanged client logic; the worker now pages
   `dataset_rows_for_tiles` (§5.5) — row-fetch drops from ~12 s to ~1 s.

---

## 11. What carries over unchanged / what retires

**Carried over unchanged (packages never import Supabase — ADR 0014):**
`@caden/data-core` (pure geojson/transform), `@caden/importers` (parse),
`@caden/geometry-archive` (PMTiles builder + reader), `@caden/maps`
(MapLibre + tile protocol + scheduler), `@caden/ui` (niko-table et al.),
`@caden/layer-styles` (validators + paint), `@caden/analysis`
(DuckDB engine — the row-resolution seam still feeds it).

**Retired with the Convex backend (replaced by §3–§9):** `@caden/json-cms`
component + its `exposeApi` wrappers and auth hook (ADR 0007), the import
workflow (`@convex-dev/workflow`), Better Auth hybrid (ADR 0006),
`app/convex/**` host functions, `dataset-rows.ts`' Convex client (superseded
by `dataset-rows-pg.ts` in stage 1, deleted from the shell — not from the
tree — at stage 7).

---

## 12. CI changes

`.github/workflows/ci.yml` (single-gate job) gains:

```yaml
services:
  postgres: # supabase/postgres ships PostGIS + the supabase extensions
    image: supabase/postgres:15.8.1.049
    env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: app }
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U postgres" --health-interval 5s
      --health-timeout 5s --health-retries 10
```

plus a step applying migrations in order:

```
for f in supabase/migrations/*.sql; do psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

and the new **PG integration tests** run with
`SUPABASE_DB_URL`/`SUPABASE_URL`/`SUPABASE_ANON_KEY` env (vitest config
unchanged in shape — the split `app/vitest.config.ts` stays; integration
files read `process.env` directly and skip-with-failure when unset).
Hermetic unit tests still never import `env.ts` unmocked (stage-3 memory).

**Push gotcha (operational):** commits touching `.github/workflows/` fail
to push over the gh HTTPS token (repo-only, no `workflow` scope) — use the
`github.com-whoiscadenyoung` SSH alias for those pushes or
`gh auth refresh -h github.com -s workflow` (the gh-push-workflow-scope
memory). This commit (docs only) is unaffected.

---

## 13. Stages and acceptance criteria

**Stage 0 — foundations.** `supabase/` scaffold (config.toml with signup
disabled, first migration: extensions postgis/pg_trgm + profiles + helper
functions); `integrations/supabase/` (client/server/provider/types); auth
swap of auth-gate/header/signin alongside the still-mounted Convex provider;
env vars; CI postgres service + migrations step.
_Accept:_ sign-in works against local Supabase; the app still runs end-to-end
on Convex with Supabase mounted beside it; CI green with migrations applied;
`git grep` shows zero edits under `app/convex/` or `packages/json-cms/`.

**Stage 1 — datasets + rows core.** Full §3.2 schema + RLS + triggers;
import pipeline (§10); row CRUD; `search_entries` wired into the table
(§8.4); reference labels; `dataset-rows-pg.ts` + store modules for the core
domains; new datasets are Postgres-native from here (transitional rule).
_Accept:_ 20k import lands in seconds; table sort/filter/search are
server-side round-trips (<100 ms warm, network tab shows RPC calls only);
row read via the seam ~1 s; locked-dataset writes denied with the
not-found/locked shapes; vitest integration tests cover RLS (anon denied;
collaborator open-edit; locked creator-only; frozen read-only), search key
validation, keyset pagination stability under inserts, and the
reference-trigger round-trip.

**Stage 2 — geometry + maps.** Map views over `entries_in_bbox` + row path;
tile-archive build fed from `dataset_rows_for_tiles`; Storage-backed
oversized geometries; popups (on-demand point reads); layer styles +
point markers via Storage + `marker_sprites`; `install_tile_archive` CAS.
_Accept:_ 20k-point dataset renders from a PG-fed archive; OPFS repeat-open
still fetches 0 archive bytes; stale-rebuild guard demonstrably rejects a
`p_expected_version` behind the current; bbox query plan uses the GiST
index (`explain` attached in the PR); markers upload + render.

**Stage 3 — catalog.** Collections/groups/joins, datasets browser, profiles.
_Accept:_ membership ops match today's behaviors (many-to-many, standalone
groups, kind denormalization); browser counts read from summary columns,
never scans; profile pages render from `profiles`.

**Stage 4 — versioning + publishing.** Versions/tags/frozen materialization
(§5.4), projects, bundles, publish flow.
_Accept:_ publish is idempotent on `publish_key` (double-submit test);
version rows immutable (no grants — negative test); tag retire refuses while
pinned (#126 shape); bundle press re-runs members exactly (per-member
status); frozen popups read materialized rows.

**Stage 5 — derived datasets + analysis + exports.** Registry rows,
seam-integrated transform application (already pure), SQL analyses,
exports.
_Accept:_ derived specs save with cycle rejection; popup enrichment
semantics byte-match the Convex executor (the pinned tests pass unchanged
against PG rows); exports byte-faithful (verbatim `source` round-trip).

**Stage 6 — realtime multi-user.** §7 channels on every active surface.
_Accept:_ two browsers editing one dataset see each other's rows < 1 s;
RLS-filtered channels never leak an invisible dataset; tile-cache live
signal updates without page subscriptions.

**Stage 7 — bound datasets + app builder + disconnect.** §3.6 tables, the
sync engine port (pg_cron reconcile weekly), app-builder tables, then the
shell disconnect: Convex provider, `convex-auth-token.ts`, Convex env vars,
and the light-query `PERSIST_KEY` bump to v3; files preserved in-tree.
_Accept:_ bound dataset syncs end-to-end against a stand-in source; the app
boots and runs every surface with zero Convex network calls (devtools
network inspection); `git grep convex` finds only preserved reference code
and the untouched `app/convex/` + `packages/json-cms/`.

---

## 14. Transitional rules

1. **From stage 1, new datasets are Postgres-native.** The create-dataset
   flow writes PG.
2. **Existing Convex datasets stay frozen** — readable through their
   existing Convex surface until that surface migrates, never edited by the
   new code. Their data may be wiped at cutover (no migration).
3. **Convex code stays in-tree untouched** for reference/revert: no edits
   under `app/convex/` or `packages/json-cms/` at any stage.
4. **The Convex provider stays mounted until stage 7**; auth is the only
   thing swapped at stage 0 (Supabase session beside the Convex session).
5. **Packages stay backend-blind**: only `app/` imports supabase-js
   (ADR 0014 dependency direction).
6. **The interim catalog is split-brain by design.** The datasets browser
   lists both stores with a source badge; cross-store features (a map with
   a Convex layer and a PG layer) are acceptable during the transition but
   not a stage gate.

---

## 15. Verification

Every stage runs the local gates from its package dir (oxfmt/oxlint; paths
must not contain `..`), `bunx tsc --noEmit` in `app/`, and `bunx vitest run`
in `app/`. The migration-specific recipe:

1. **Stack up:** `supabase start` → `supabase db reset` (applies all
   migrations) → `supabase gen types typescript --local >
app/src/integrations/supabase/types.ts` (committed types refreshed;
   CI's service container applies the same files).
2. **The 20k A/B** (adapted from `docs/map-performance-handoff-2026-10-29.md`
   steps 5–8, Convex-backend steps dropped): generate the 20k-point
   FeatureCollection, serve with CORS from a scratch Bun server, import via
   the in-app flow. Measure, with the page timer installed before Create:
   - full row read (seam to exhaustion): **target ~1 s** (Convex: ~12 s);
   - import wall-clock: **target seconds** (Convex: 17.3 s);
   - table sort/filter/search round-trips: server RPC < 100 ms warm
     (Convex: client-side over the full fetch);
   - tile build + install: worker time ~unchanged (~2.4 s), fetch phase ~1 s;
   - repeat dataset open: 0 archive bytes (OPFS pin still absorbs it).
3. **In-app browser on `localhost:3000`** (it reaches localhost — the
   map-performance-audit-2026-10 memory supersedes the old curl-only rule):
   sign in; dataset page renders; table interactions hit `search_entries`;
   map renders from tiles; entry edit propagates to a second browser
   context via Realtime; locked dataset denies with the recorded shapes;
   publish freezes and the frozen read path works.
4. **RLS negative tests in vitest** (against the docker PG / CI service):
   anon denied everywhere; open dataset co-edited by a second user; locked
   dataset creator-only; frozen version rows immutable; search_entries
   rejects undeclared keys; drafts invisible to non-creators.
5. **Realtime check:** RLS-respecting channel receives only permitted rows.

The Convex A/B numbers being compared against are the recorded measurements
(`published-map-load-options-2026-10-29.md`), not re-measured.

---

## 16. Open questions (carried, non-blocking)

- VPS operational shape for the ~10-service stack (compose vs k8s) —
  decided at deployment time, after local stages prove out.
- Whether `pg_cron` runs self-hosted reconcile on the same instance or a
  sidecar — stage 7 detail.
- Realtime subscriber scaling ceiling on self-hosted — measure at stage 6
  with 10+ concurrent tabs before relying on broad channel use.
- Storage signed-URL TTL vs the OPFS pin's long-lived reads — pick at
  stage 2 (a longer TTL or a public-read bucket for archives).

---

## 17. Local bring-up status (stage 0, recorded 2026-11-03)

Recorded by the stage-0 scaffold run in the `jdm-supabase-backend` worktree.

**The stack is up.** `supabase start` → `supabase db reset` both completed,
and the bring-up checks passed:

- CLI is not installed natively — everything ran as `bunx supabase`
  (**CLI 3.0.0**; note `--local` on `gen types` is deprecated, dropped in
  v4). Docker Desktop was installed but not running; `open -a Docker`
  started it (daemon 29.4.1 → 29.9.2 after a mid-bring-up crash-restart).
- `supabase init` generated `supabase/config.toml`; edited for this
  migration: `major_version = 15` (the CLI 3.0.0 default is 17 — pinned to
  15 to match §2 and the §12 CI image `supabase/postgres:15.8.1.049`),
  `[auth] enable_signup = false` (§9), and `[analytics] enabled = false`.
- First two `supabase start` attempts failed their health checks on the
  logflare+vector analytics containers (the realtime VM also raised a
  `system_memory_high_watermark` alarm) and a third attempt crashed Docker
  Desktop itself. Disabling the analytics stack (not part of §2's runtime
  topology; only Studio's log explorer is lost) resolved it — fourth start
  succeeded. `supabase db reset` then re-applied migrations cleanly
  (it skips `migrations/README.md` by filename pattern, as intended).
- Verified in the database (`psql` inside `supabase_db`):
  `postgis 3.3.2` (`postgis_full_version()` reports `PGSQL="150"` — PG 15),
  `pg_trgm 1.6`. All core containers healthy: db, auth (GoTrue
  `/auth/v1/health` → 200), rest (`/rest/v1/` with the publishable key →
  200), realtime, storage, studio, kong, pg_meta, inbucket. Stopped by
  design: analytics, vector, imgproxy, edge_runtime, pooler.
- Typed bindings generated: `supabase gen types typescript --local >
app/src/lib/supabase/database.types.ts` (oxfmt-formatted). `public` is
  empty (`Tables: { [_ in never]: never } …`) as expected before the
  core-schema migration — regenerate after each schema stage lands.
- Local values for the app integrator's `app/.env.local`:
  `VITE_SUPABASE_URL=http://127.0.0.1:54321`,
  `VITE_SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`
  (CLI 3 prints new-format keys; `bunx supabase status` prints the rest,
  including the local-only secret key for §9's admin user creation). The
  DB URL is `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- Runtime dirs `.branches/`/`.temp/`/`.logs/` are ignored via
  `supabase/.gitignore` (the CLI's own generated file covers the first two;
  `.logs` added).
- Restart recipe after a reboot or Docker quit: `open -a Docker`, wait for
  the daemon, then `bunx supabase start` in the repo root (stack state
  persists in the Docker volumes; no reset needed unless schema changed —
  then `bunx supabase db reset`).

**Review-fix addendum (2026-11-03, PR #207).** The stage-0 review found two
must-fix gaps; both are fixed and verified as below.

- `supabase/migrations/0002_profiles.sql` now ships the §3.1 half of the
  stage-0 contract (table, `handle_new_user`, RLS projection). One
  deliberate deviation from the §3.1 sketch, recorded there too: the
  trigger reads `confirmed_at`, not `email_confirmed_at` — the pinned CI
  image (supabase/postgres 15.8.1.049) carries only `confirmed_at` (checked
  in `information_schema.columns`), while the local CLI 3.0.0 stack has
  both; `confirmed_at` is set whenever GoTrue marks the account confirmed.
- Verified in a throwaway `supabase/postgres:15.8.1.049` container
  replicating the §12 CI store gate (both migrations applied in lexical
  order as `supabase_admin`, `ON_ERROR_STOP=1`, both clean), plus smoke
  tests in that container: an `auth.users` insert mints the matching
  profiles row (confirmed → `email_verified true`, unconfirmed → false;
  `raw_user_meta_data` name/avatar projected); RLS as a signed-in user
  reads every profile and updates ONLY the self row (`auth.uid()` via
  `request.jwt.claim.sub` — this image's `auth.uid()` reads that GUC, not
  the whole-claims JSON); anon sees 0 rows; deleting the auth user removes
  the profile (cascade).
- NOT verified here: the live sign-in flow end-to-end (the app dev server
  and the local Convex backend were not running during this fix run). The
  §9 account-pair recipe (service-role/Studio user + matching
  `auth:createAccount`) and the two-session bridge's runtime behavior are
  to be exercised by the §15 step-3 verification before the stage is
  declared done.
- Local-stack note: the running local DB already carries a hand-applied
  profiles schema (matches §3.1 modulo policy names, `confirmed_at`-era
  trigger body) plus §3.2-sketch tables (datasets/entries/geometries/
  imports/entry_references) that were applied outside `supabase/migrations/`
  (§17 recorded `public` as empty at scaffold time — this arrived after).
  0002 was therefore NOT applied to the running local DB; it applies
  cleanly on a fresh database, and the next `supabase db reset` rebuilds
  the local stack from the shipped migration set.

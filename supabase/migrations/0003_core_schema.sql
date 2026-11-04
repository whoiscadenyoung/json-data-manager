-- Stage 1 — datasets + rows core (docs/supabase-migration-design.md §3.2, §4, §5).
--
-- Tables: datasets, entries, geometries, entry_references, imports (§3.2's
-- stage-1 DDL sketch, verbatim column-for-column except `datasets.group_id`,
-- which the sketch itself defers to stage 3 and whose target table does not
-- exist yet).
--
-- Triggers (§3.2):
--   entries_build_search            — BEFORE row; tsvector over the dataset's
--                                     DECLARED property keys (generated
--                                     columns cannot reference other tables)
--   datasets_maintain_entries       — AFTER statement (transition tables):
--                                     entry_count ±, datasets.updated_at
--   datasets_maintain_geometries    — AFTER statement: feature_count ±,
--                                     expand-only bbox envelope, per-row bbox
--                                     fill, max_geometry_row_bytes (advisory),
--                                     map_tile_cache_version bump on every
--                                     geometry-affecting write, emptying-clear
--                                     reset (component schema.ts:222-243 parity)
--   entry_refs_sync                 — AFTER statement: entry_references
--                                     derivation on entry writes (component
--                                     entries.ts delete-and-rederive parity)
--   set_updated_at                  — §3's shared updated_at trigger
--
-- Statement-level triggers with transition tables (instead of per-row) keep
-- import_entries set-based: one summary UPDATE per chunk statement, not per
-- row. FK-cascade deletes DO fire them with the full row set (verified
-- against PG 15: a cascaded delete populated `old table` with all cascaded
-- rows), so ON DELETE CASCADE paths keep counts exact.
--
-- RLS: §4 — two SECURITY DEFINER helpers, policies per the §4 matrix rows
-- for these five tables. RPCs: §5.1 search_entries, §5.2 entries_in_bbox,
-- §5.3 import_entries, §5.5 dataset_rows_for_tiles — all SECURITY INVOKER.

-- ---------------------------------------------------------------------------
-- §3 conventions — shared updated_at maintenance
-- ---------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- §3.2 — datasets
-- ---------------------------------------------------------------------------

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
  -- lines 222-243 semantics: never shrinks on delete; reset by clear).
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
  -- group_id arrives with stage 3 (the sketch defers it; public.groups does
  -- not exist until then).
  created_by        uuid not null default auth.uid() references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index datasets_by_creator on public.datasets (created_by);
create index datasets_by_lifecycle on public.datasets (lifecycle, published_visibility, created_at desc);

-- ---------------------------------------------------------------------------
-- §3.2 — entries
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- §3.2 — geometries
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- §3.2 — entry_references
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- §3.2 — imports
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Search-vector builder: to_tsvector('simple', ...) of data->>key for every
-- key in the owning dataset's declared properties, folded with the tsvector
-- || operator (the sketch's "implementation detail" note). Rebuilds on
-- INSERT and on UPDATE OF data. SECURITY DEFINER so the datasets read never
-- depends on the invoker's RLS view of the row it is editing.
create function public.entries_build_search() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_keys   jsonb;
  v_vector tsvector;
  v_key    text;
begin
  select d.properties into v_keys from public.datasets d where d.id = new.dataset_id;
  v_vector := ''::tsvector;
  if v_keys is not null and jsonb_typeof(v_keys) = 'array' then
    for v_key in select jsonb_array_elements_text(v_keys) loop
      v_vector := v_vector || to_tsvector('simple', coalesce(new.data ->> v_key, ''));
    end loop;
  end if;
  new.search := v_vector;
  return new;
end $$;

create trigger entries_search before insert or update of data on public.entries
  for each row execute function public.entries_build_search();

-- entry_count maintenance + datasets.updated_at touch (statement-level; the
-- UPDATE below also fires datasets' set_updated_at trigger).
create function public.datasets_maintain_entries() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    update public.datasets d
    set entry_count = d.entry_count + x.n
    from (select t.dataset_id, count(*) as n from new_entries t group by t.dataset_id) x
    where d.id = x.dataset_id;
  elsif tg_op = 'DELETE' then
    update public.datasets d
    set entry_count = greatest(d.entry_count - x.n, 0)
    from (select t.dataset_id, count(*) as n from old_entries t group by t.dataset_id) x
    where d.id = x.dataset_id;
  elsif tg_op = 'UPDATE' then
    -- Content changed; keep the dataset's updated_at fresh.
    update public.datasets d
    set updated_at = now()
    where d.id in (select t.dataset_id from new_entries t);
  end if;
  return null;
end $$;

-- One event per trigger: PG forbids transition tables on multi-event
-- triggers (and on column-list triggers) — both verified against PG 15.
create trigger datasets_entries_maintain_insert
after insert on public.entries
referencing new table as new_entries
for each statement execute function public.datasets_maintain_entries();

create trigger datasets_entries_maintain_delete
after delete on public.entries
referencing old table as old_entries
for each statement execute function public.datasets_maintain_entries();

create trigger datasets_entries_maintain_update
after update on public.entries
referencing new table as new_entries
for each statement execute function public.datasets_maintain_entries();

-- feature_count / bbox / map_tile_cache_version / max_geometry_row_bytes
-- maintenance (statement-level). Also fills per-geometry `bbox` from the
-- generated `geom` when the client did not supply one: generated columns are
-- computed AFTER BEFORE triggers (verified on PG 15 — NEW.geom is null
-- there), so this is the only hook that can see geom.
create function public.datasets_maintain_geometries() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  -- The per-row bbox backfill below issues an UPDATE on geometries, which
  -- re-fires this trigger; nested invocations must be no-ops (counts, the
  -- envelope and the tile version already reflect the outer statement).
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    update public.geometries g
    set bbox = array[st_xmin(g.geom), st_ymin(g.geom), st_xmax(g.geom), st_ymax(g.geom)]
    from new_geometries n
    where g.id = n.id
      and g.bbox is null
      and g.geom is not null;

    update public.datasets d
    set feature_count = d.feature_count
                      + case when tg_op = 'INSERT' then x.n else 0 end,
        map_tile_cache_version = d.map_tile_cache_version + 1,
        max_geometry_row_bytes = greatest(d.max_geometry_row_bytes, x.max_bytes),
        bbox = case
          when x.extent is null then d.bbox
          when d.bbox is null then x.extent
          else st_makeenvelope(
            least(st_xmin(d.bbox), st_xmin(x.extent)),
            least(st_ymin(d.bbox), st_ymin(x.extent)),
            greatest(st_xmax(d.bbox), st_xmax(x.extent)),
            greatest(st_ymax(d.bbox), st_ymax(x.extent)),
            4326)
        end
    from (
      select t.dataset_id,
             count(*) as n,
             -- The union envelope of this statement's geometries, always a
             -- POLYGON: st_envelope degenerates to POINT/LINESTRING for
             -- single-point / collinear extents, which the Polygon-typmod
             -- column refuses; st_makeenvelope from the row extents never
             -- does.
             (select st_makeenvelope(
                       min(st_xmin(g.geom)), min(st_ymin(g.geom)),
                       max(st_xmax(g.geom)), max(st_ymax(g.geom)), 4326)
                from new_geometries g
               where g.dataset_id = t.dataset_id
                 and g.geom is not null) as extent,
             max(coalesce(t.source_bytes,
                 case when t.source is null then 262144  -- storage-backed rows charge INLINE_GEOMETRY_SOURCE_BYTES (§6, 256 KB)
                      else octet_length(t.source::text) end)) as max_bytes
      from new_geometries t
      group by t.dataset_id
    ) x
    where d.id = x.dataset_id;
  elsif tg_op = 'DELETE' then
    update public.datasets d
    set feature_count = greatest(d.feature_count - x.n, 0),
        map_tile_cache_version = d.map_tile_cache_version + 1
    from (select t.dataset_id, count(*) as n from old_geometries t group by t.dataset_id) x
    where d.id = x.dataset_id;

    -- Expand-only rule: the envelope never shrinks on delete, EXCEPT an
    -- emptying clear (feature_count reaching 0) resets it — and with it the
    -- advisory max row bytes (component schema semantics).
    update public.datasets d
    set bbox = null,
        max_geometry_row_bytes = null
    where d.feature_count <= 0
      and d.id in (select t.dataset_id from old_geometries t);
  end if;
  return null;
end $$;

create trigger datasets_geometries_maintain_insert
after insert on public.geometries
referencing new table as new_geometries
for each statement execute function public.datasets_maintain_geometries();

create trigger datasets_geometries_maintain_update
after update on public.geometries
referencing new table as new_geometries
for each statement execute function public.datasets_maintain_geometries();

create trigger datasets_geometries_maintain_delete
after delete on public.geometries
referencing old table as old_geometries
for each statement execute function public.datasets_maintain_geometries();

-- entry_references derivation on entry writes. NOTE: statement-level
-- transition tables cannot combine with `update of <column>` nor with
-- multi-event triggers (both PG restrictions, verified), so the update
-- trigger fires on every entry UPDATE — re-derivation is idempotent,
-- matching the component's delete-and-rederive on writes.
create function public.entry_refs_sync() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'DELETE' then
    delete from public.entry_references r
    where r.source_entry_id in (select o.id from old_entries o);
    return null;
  end if;

  delete from public.entry_references r
  where r.source_entry_id in (select n.id from new_entries n);

  insert into public.entry_references
    (source_entry_id, source_dataset_id, target_entry_id, target_dataset_id, field_name)
  select distinct
    n.id, n.dataset_id, tgt.id, tgt.dataset_id, p.field_name
  from new_entries n
  join public.datasets d
    on d.id = n.dataset_id
   and jsonb_typeof(d.json_schema) = 'object'
   and jsonb_typeof(d.json_schema -> 'properties') = 'object'
  cross join lateral jsonb_each(d.json_schema -> 'properties') as p(field_name, prop)
  join lateral (
    select p.prop -> 'x-reference' as meta
    where jsonb_typeof(p.prop -> 'x-reference') = 'object'
      and p.prop -> 'x-reference' ->> 'cardinality' in ('one', 'many')
  ) rf on true
  join lateral (
    -- Candidate target ids, per cardinality (the client's
    -- extractReferenceIds: 'one' = a single non-empty string; 'many' =
    -- the array's non-empty strings — non-strings never qualify).
    select c.candidate_id
    from (
      select n.data ->> p.field_name as candidate_id
      where rf.meta ->> 'cardinality' = 'one'
        and jsonb_typeof(n.data -> p.field_name) = 'string'
        and length(n.data ->> p.field_name) > 0
      union all
      select el #>> '{}'
      from jsonb_array_elements(
             case when rf.meta ->> 'cardinality' = 'many'
                       and jsonb_typeof(n.data -> p.field_name) = 'array'
                  then n.data -> p.field_name
                  else '[]'::jsonb end
           ) as el
      where jsonb_typeof(el) = 'string'
        and length(el #>> '{}') > 0
    ) c
    where c.candidate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) cand on true
  -- CASE (not WHERE) guards the cast: only uuid-shaped text is cast, so
  -- arbitrary strings can never raise; values that name no existing entry
  -- simply join to nothing ("names an existing entry id becomes one row").
  join public.entries tgt
    on tgt.id = (case when cand.candidate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      then cand.candidate_id::uuid end);
  return null;
end $$;

create trigger entry_refs_maintain_insert
after insert on public.entries
referencing new table as new_entries
for each statement execute function public.entry_refs_sync();

create trigger entry_refs_maintain_update
after update on public.entries
referencing new table as new_entries
for each statement execute function public.entry_refs_sync();

create trigger entry_refs_maintain_delete
after delete on public.entries
referencing old table as old_entries
for each statement execute function public.entry_refs_sync();

create trigger datasets_set_updated_at before update on public.datasets
  for each row execute function public.set_updated_at();
create trigger entries_set_updated_at before update on public.entries
  for each row execute function public.set_updated_at();
create trigger geometries_set_updated_at before update on public.geometries
  for each row execute function public.set_updated_at();
create trigger imports_set_updated_at before update on public.imports
  for each row execute function public.set_updated_at();

-- §3 attribution (the ADR 0007 pattern): created_by is stamped from the
-- request's identity, never claimed from a client payload — a direct
-- PostgREST insert can neither omit nor spoof it (import_entries already
-- stamps auth.uid() explicitly; the trigger makes the table path hold to the
-- same rule). Runs BEFORE the RLS WITH CHECK, so the checked row carries the
-- invoker's id.
create function public.stamp_created_by() returns trigger
language plpgsql as $$
begin
  new.created_by := auth.uid();
  return new;
end $$;

create trigger entries_stamp_created_by before insert on public.entries
  for each row execute function public.stamp_created_by();
create trigger geometries_stamp_created_by before insert on public.geometries
  for each row execute function public.stamp_created_by();
create trigger imports_stamp_created_by before insert on public.imports
  for each row execute function public.stamp_created_by();

-- ---------------------------------------------------------------------------
-- §4 — RLS helpers (SECURITY DEFINER + pinned search_path: the datasets
-- policies themselves call these, so they must not recurse; STABLE so they
-- may appear in USING clauses). Verbatim from §4.
-- ---------------------------------------------------------------------------

-- Who may READ a dataset: drafts are private to their creator;
-- publishedVisibility 'author' restricts reads to the creator; everything
-- else is readable by any signed-in user (ADR 0009 + stage-8 model).
create function public.can_view_dataset(p_dataset uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
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
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset
      and auth.uid() is not null
      and d.lineage is null
      and (d.edit_policy = 'open' or d.created_by = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- §4 — RLS policies (all TO authenticated; anon gets nothing)
-- ---------------------------------------------------------------------------

alter table public.datasets         enable row level security;
alter table public.entries          enable row level security;
alter table public.geometries       enable row level security;
alter table public.entry_references enable row level security;
alter table public.imports          enable row level security;

create policy "datasets select: can_view_dataset"
  on public.datasets for select to authenticated
  using (public.can_view_dataset(id));

-- INSERT cannot call can_edit_dataset(id): the function reads the datasets
-- table, and the row being inserted is not there yet (WITH CHECK sees the
-- proposed row, not a stored one). The same §4 predicate applied to the new
-- row's own values: authenticated, never born frozen, and creator-only when
-- the row declares edit_policy 'locked' — plus the §3 identity pin (the ADR
-- 0007 pattern): created_by is STAMPED to the invoker, never claimed from a
-- client payload, so a dataset can never be attributed to another profile.
create policy "datasets insert: can_edit_dataset semantics on the new row"
  on public.datasets for insert to authenticated
  with check (
    auth.uid() is not null
    and created_by = auth.uid()
    and lineage is null
    and (edit_policy = 'open' or created_by = auth.uid())
  );

-- UPDATE re-checks can_edit_dataset on both sides: flipping edit_policy is
-- itself a gated write (the setEditPolicy rule, §4 matrix).
create policy "datasets update: can_edit_dataset"
  on public.datasets for update to authenticated
  using (public.can_edit_dataset(id))
  with check (public.can_edit_dataset(id));

-- The setEditPolicy rule itself (ADR 0010; app/convex/cms/schemas.ts:478:
-- "Locking is itself a write the policy gates, so only the creator can flip
-- it either way"): a restrictive policy ANDs with the permissive one above,
-- so a collaborator on an open dataset can update real fields but cannot
-- move edit_policy to 'locked' — only the creator (or an already-locked
-- dataset's creator, whom the permissive policy alone admits) can.
create policy "datasets update: edit_policy flips are creator-only"
  on public.datasets as restrictive for update to authenticated
  using (true)
  with check (edit_policy = 'open' or created_by = auth.uid());

create policy "datasets delete: can_edit_dataset"
  on public.datasets for delete to authenticated
  using (public.can_edit_dataset(id));

-- §4: "the client never needs the direct UPDATE right on maintained columns
-- — but dataset UPDATE remains available for real fields". Column-level
-- grants make that literal: the summary/tile bookkeeping is trigger-maintained
-- (entry_count, feature_count, bbox, max_geometry_row_bytes,
-- map_tile_cache_version), and lineage/created_by/created_at/updated_at plus
-- the archive columns are server- or host-flow-owned — a client-writable
-- lineage would freeze a dataset read-only for everyone with no unfreeze
-- path, and map_tile_cache_version is the CAS value install_tile_archive
-- compares (§5.6). The SECURITY DEFINER triggers/RPCs run as the owner and
-- keep their full access; a rejected column surfaces as a PostgREST
-- permission error, not a silent no-op.
revoke update on public.datasets from authenticated;
grant update (title, description, json_schema, properties,
              is_geospatial, geometry_type, simplify_geometry,
              edit_policy, published_visibility, lifecycle,
              source_file_name, source_file_size, source_file_path)
  on public.datasets to authenticated;

create policy "entries select: can_view_dataset"
  on public.entries for select to authenticated
  using (public.can_view_dataset(dataset_id));

create policy "entries insert: can_edit_dataset"
  on public.entries for insert to authenticated
  with check (public.can_edit_dataset(dataset_id));

create policy "entries update: can_edit_dataset"
  on public.entries for update to authenticated
  using (public.can_edit_dataset(dataset_id))
  with check (public.can_edit_dataset(dataset_id));

create policy "entries delete: can_edit_dataset"
  on public.entries for delete to authenticated
  using (public.can_edit_dataset(dataset_id));

create policy "geometries select: can_view_dataset"
  on public.geometries for select to authenticated
  using (public.can_view_dataset(dataset_id));

create policy "geometries insert: can_edit_dataset"
  on public.geometries for insert to authenticated
  with check (public.can_edit_dataset(dataset_id));

create policy "geometries update: can_edit_dataset"
  on public.geometries for update to authenticated
  using (public.can_edit_dataset(dataset_id))
  with check (public.can_edit_dataset(dataset_id));

create policy "geometries delete: can_edit_dataset"
  on public.geometries for delete to authenticated
  using (public.can_edit_dataset(dataset_id));

-- Viewable when either side is viewable; no INSERT/UPDATE/DELETE policies —
-- writes happen only through entry writes (trigger-owned; §4 matrix).
create policy "entry_references select: either side viewable"
  on public.entry_references for select to authenticated
  using (public.can_view_dataset(source_dataset_id) or public.can_view_dataset(target_dataset_id));

create policy "imports select: can_view_dataset"
  on public.imports for select to authenticated
  using (public.can_view_dataset(dataset_id));

create policy "imports insert: can_edit_dataset"
  on public.imports for insert to authenticated
  with check (public.can_edit_dataset(dataset_id));

create policy "imports update: can_edit_dataset"
  on public.imports for update to authenticated
  using (public.can_edit_dataset(dataset_id))
  with check (public.can_edit_dataset(dataset_id));

create policy "imports delete: can_edit_dataset"
  on public.imports for delete to authenticated
  using (public.can_edit_dataset(dataset_id));

-- ---------------------------------------------------------------------------
-- §5.1 — search_entries (SECURITY INVOKER: RLS applies inside)
-- ---------------------------------------------------------------------------

create function public.search_entries(
  p_dataset uuid,
  p_query   text   default null,   -- websearch syntax; null/'' = no search filter
  p_filters jsonb  default null,   -- array of {key, op, value}; op in ('eq','neq','contains','gt','gte','lt','lte','in')
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
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_keys        jsonb;
  v_sort_key    text;
  v_sort_dir    text;
  v_limit       integer;
  v_where       text;
  v_order       text;
  v_keyexpr     text;
  v_cond        text;
  v_f           jsonb;
  v_fkey        text;
  v_fop         text;
  v_cursor      jsonb;
  v_cursor_val  jsonb;
  v_cursor_id   uuid;
  v_cursor_ts   timestamptz;
  v_sql         text;
  v_ids         uuid[];
  v_datas       jsonb[];
  v_gtypes      text[];
  v_createds    timestamptz[];
  v_next_id     uuid;
  v_next_data   jsonb;
  v_next_created timestamptz;
  v_has_more    boolean;
  v_payload     jsonb;
  v_next        text;
  v_numre       text := '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$';
begin
  v_limit := greatest(1, coalesce(p_limit, 200));

  -- Key validation reads the dataset's declared properties under the
  -- invoker's RLS: an invisible dataset surfaces as "not found" (§4 denial
  -- shape), and its keys are unknowable anyway.
  select d.properties into v_keys from public.datasets d where d.id = p_dataset;
  if v_keys is null then
    raise exception 'dataset not found or not visible';
  end if;
  if jsonb_typeof(v_keys) is distinct from 'array' then
    v_keys := '[]'::jsonb;
  end if;

  -- Decode + validate the keyset cursor (opaque base64 of a jsonb payload:
  -- {"i": "<entry uuid>"} plus "s" (sort value) or "t" (created_at)).
  if p_cursor is not null then
    begin
      v_cursor := convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb;
    exception when others then
      raise exception 'invalid cursor';
    end;
    if v_cursor is null or jsonb_typeof(v_cursor) is distinct from 'object'
      or v_cursor ->> 'i' is null then
      raise exception 'invalid cursor';
    end if;
    begin
      v_cursor_id := (v_cursor ->> 'i')::uuid;
      if v_cursor ? 's' then
        v_cursor_val := v_cursor -> 's';
      end if;
      if v_cursor ? 't' then
        v_cursor_ts := (v_cursor ->> 't')::timestamptz;
      end if;
    exception when others then
      raise exception 'invalid cursor';
    end;
  end if;

  -- Validate the sort key BEFORE it reaches any SQL (§5.1 hard requirement:
  -- user input never becomes SQL — the key rides as a bound parameter even
  -- after validation; validation is the semantic gate).
  if p_sort is not null then
    if jsonb_typeof(p_sort) is distinct from 'object' then
      raise exception 'p_sort must be an object {key, dir}';
    end if;
    v_sort_key := p_sort ->> 'key';
    v_sort_dir := coalesce(p_sort ->> 'dir', 'asc');
    if v_sort_dir not in ('asc', 'desc') then
      raise exception 'invalid sort dir: %', v_sort_dir;
    end if;
    if v_sort_key is null or not (v_keys @> to_jsonb(v_sort_key)) then
      raise exception 'invalid key: %', coalesce(v_sort_key, '<null>');
    end if;
  end if;

  v_where := 'e.dataset_id = $1';
  if p_query is not null and p_query <> '' then
    v_where := v_where
      || ' and e.search @@ websearch_to_tsquery(''simple'', $2)';
  end if;

  if p_filters is not null then
    if jsonb_typeof(p_filters) is distinct from 'array' then
      raise exception 'p_filters must be an array of {key, op, value}';
    end if;
    for i in 0 .. jsonb_array_length(p_filters) - 1 loop
      v_f := p_filters -> i;
      if jsonb_typeof(v_f) is distinct from 'object' then
        raise exception 'p_filters[%] must be an object {key, op, value}', i;
      end if;
      v_fkey := v_f ->> 'key';
      v_fop  := v_f ->> 'op';
      if v_fkey is null or not (v_keys @> to_jsonb(v_fkey)) then
        raise exception 'invalid key: %', coalesce(v_fkey, '<null>');
      end if;
      if v_fop not in ('eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in') then
        raise exception 'invalid op: %', coalesce(v_fop, '<null>');
      end if;
      -- Only structural SQL (chosen from the fixed whitelist above) is
      -- interpolated; keys and values ride inside the $3 parameter.
      if v_fop = 'eq' then
        v_cond := format(
          '(e.data @> jsonb_build_object($3 -> %1$s ->> ''key'', $3 -> %1$s -> ''value''))', i);
      elsif v_fop = 'neq' then
        v_cond := format(
          '(not (e.data @> jsonb_build_object($3 -> %1$s ->> ''key'', $3 -> %1$s -> ''value'')))', i);
      elsif v_fop = 'contains' then
        -- Case-insensitive substring over data->>key (the table UI's
        -- includes() semantics); empty value matches everything.
        v_cond := format(
          '(strpos(lower(e.data ->> ($3 -> %1$s ->> ''key'')), lower(coalesce($3 -> %1$s ->> ''value'', ''''))) > 0)', i);
      elsif v_fop in ('gt', 'gte', 'lt', 'lte') then
        -- Ranges are numeric (the client's LT/GTE/etc compare Number(cell)
        -- against Number(value) and skip NaN pairs); non-numeric cell
        -- values or filter values therefore match nothing, exactly as the
        -- client's NaN guard does. CASE keeps both casts null-safe.
        v_cond := format(
          '(case when e.data ->> ($3 -> %1$s ->> ''key'') ~ %2$L then (e.data ->> ($3 -> %1$s ->> ''key''))::numeric end'
          || ' %3$s case when ($3 -> %1$s ->> ''value'') ~ %2$L then ($3 -> %1$s ->> ''value'')::numeric end)',
          i, v_numre, (case v_fop when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end));
      else  -- 'in'
        -- Exact text membership over data->>key.
        v_cond := format(
          '(lower(e.data ->> ($3 -> %1$s ->> ''key'')) in (select lower(v) from jsonb_array_elements_text(case when jsonb_typeof($3 -> %1$s -> ''value'') = ''array'' then $3 -> %1$s -> ''value'' else ''[]''::jsonb end) as v))', i);
      end if;
      v_where := v_where || ' and ' || v_cond;
    end loop;
  end if;

  -- Sort: jsonb ordering (e.data -> key) so number columns sort numerically
  -- and string columns lexicographically, matching the client's typed sort;
  -- the doc sketch's data->> would order numbers as text ("10" < "9").
  -- Missing keys: SQL NULL — PG's default null placement (asc = last,
  -- desc = first) and the keyset predicates below mirror it exactly.
  if v_sort_key is not null then
    v_keyexpr := 'e.data -> ($4 ->> ''key'')';
    if v_sort_dir = 'asc' then
      v_order := v_keyexpr || ' asc, e.id desc';
      if p_cursor is not null then
        -- Ascending is NULLS LAST, and the tiebreak runs id DESC, so
        -- "strictly after" the cursor row means: a LARGER key value, or the
        -- SAME value with a SMALLER id — plus every null-key row once the
        -- cursor carried a value (and, when the cursor itself was a null-key
        -- row, the null-key rows after it in id-desc order). A row comparison
        -- `(key, id) > ($5, $6)` would be wrong here: it resolves ties as
        -- `id > cursor_id`, which against the id-desc tiebreak re-returns
        -- already-shown rows and permanently skips the lower-id rows that
        -- share the sort value.
        v_where := v_where || format(
          ' and ((%1$s is not null and $5 is not null'
          || ' and (%1$s > $5 or (%1$s = $5 and e.id < $6)))'
          || ' or (%1$s is null and ($5 is not null or e.id < $6)))',
          v_keyexpr);
      end if;
    else
      v_order := v_keyexpr || ' desc, e.id desc';
      if p_cursor is not null then
        v_where := v_where || format(
          ' and ((%1$s is not null and (%1$s, e.id) < ($5, $6))'
          || ' or (%1$s is null and $5 is null and e.id < $6))',
          v_keyexpr);
      end if;
    end if;
  else
    v_order := 'e.created_at desc, e.id desc';
    if p_cursor is not null then
      v_where := v_where || ' and (e.created_at, e.id) < ($7, $6)';
    end if;
  end if;

  -- next_cursor is the LAST RETURNED row's sort tuple (page 2 = strictly
  -- after row p_limit); the (p_limit+1)th row is fetched only to decide
  -- exhaustion — its existence makes next_cursor non-null (§5.1, §8.3).
  -- row_number is ordered identically to the sort so rn is deterministic.
  v_sql := 'select'
    || ' coalesce(array_agg(q.id) filter (where q.rn <= $8::int), ''{}'') as ids,'
    || ' coalesce(array_agg(q.data) filter (where q.rn <= $8::int), ''{}'') as datas,'
    || ' coalesce(array_agg(q.geometry_type) filter (where q.rn <= $8::int), ''{}'') as gtypes,'
    || ' coalesce(array_agg(q.created_at) filter (where q.rn <= $8::int), ''{}'') as createds,'
    || ' (array_agg(q.id) filter (where q.rn = $8::int))[1] as last_id,'
    || ' (array_agg(q.data) filter (where q.rn = $8::int))[1] as last_data,'
    || ' (array_agg(q.created_at) filter (where q.rn = $8::int))[1] as last_created,'
    || ' (array_agg(q.id) filter (where q.rn = $8::int + 1))[1] is not null as has_more'
    || ' from ('
    ||   ' select e.id, e.data, e.geometry_type, e.created_at,'
    ||   ' row_number() over (order by ' || v_order || ') as rn'
    ||   ' from public.entries e'
    ||   ' where ' || v_where
    ||   ' order by ' || v_order
    ||   ' limit $8::int + 1'
    || ' ) q';

  execute v_sql
    into v_ids, v_datas, v_gtypes, v_createds, v_next_id, v_next_data, v_next_created, v_has_more
    using p_dataset, p_query, p_filters, p_sort, v_cursor_val, v_cursor_id, v_cursor_ts, v_limit;

  if v_has_more and v_next_id is not null then
    v_payload := jsonb_build_object('i', v_next_id);
    if v_sort_key is not null then
      if (v_next_data -> v_sort_key) is not null then
        v_payload := v_payload || jsonb_build_object('s', v_next_data -> v_sort_key);
      end if;
    else
      v_payload := v_payload || jsonb_build_object('t', v_next_created);
    end if;
    v_next := encode(convert_to(v_payload::text, 'utf8'), 'base64');
  end if;

  for i in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    id            := v_ids[i];
    data          := v_datas[i];
    geometry_type := v_gtypes[i];
    created_at    := v_createds[i];
    next_cursor   := v_next;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- §5.2 — entries_in_bbox (SECURITY INVOKER)
-- ---------------------------------------------------------------------------

create function public.entries_in_bbox(
  p_dataset uuid,
  p_bbox    jsonb    -- [minLon, minLat, maxLon, maxLat]
)
returns table (
  id uuid, data jsonb, geometry jsonb, geometry_type text, bbox double precision[]
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  if p_bbox is null or jsonb_typeof(p_bbox) is distinct from 'array'
    or jsonb_array_length(p_bbox) <> 4 then
    raise exception 'p_bbox must be [minLon, minLat, maxLon, maxLat]';
  end if;
  if exists (select 1 from jsonb_array_elements(p_bbox) el where jsonb_typeof(el) <> 'number') then
    raise exception 'p_bbox must be four numbers';
  end if;
  if (p_bbox ->> 0)::double precision > (p_bbox ->> 2)::double precision
    or (p_bbox ->> 1)::double precision > (p_bbox ->> 3)::double precision then
    raise exception 'p_bbox must satisfy minLon <= maxLon and minLat <= maxLat';
  end if;

  -- geom && envelope is served by geometries_geom_gist; storage-backed rows
  -- (geom is null) are skipped — viewport reads fetch those from Storage
  -- URLs separately (§5.2).
  return query
  select e.id, e.data, g.source, e.geometry_type, g.bbox
  from public.entries e
  join public.geometries g on g.entry_id = e.id
  where e.dataset_id = p_dataset
    and g.geom is not null
    and g.geom && st_makeenvelope(
      (p_bbox ->> 0)::double precision,
      (p_bbox ->> 1)::double precision,
      (p_bbox ->> 2)::double precision,
      (p_bbox ->> 3)::double precision,
      4326)
  order by e.id;
end $$;

-- ---------------------------------------------------------------------------
-- §5.3 — import_entries (SECURITY INVOKER; RLS gates every write inside)
-- ---------------------------------------------------------------------------

create function public.import_entries(
  p_dataset uuid,
  p_rows    jsonb     -- [{data, geometry?, geometryType?, geometrySourcePath?, geometrySourceBytes?, bbox?}]
)
returns integer            -- rows inserted
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_count integer := 0;
begin
  -- The clear path (§3.2): an empty rows array clears the dataset; the
  -- statement triggers on entries (and the geometries cascade) reset the
  -- summaries exactly as any delete would.
  if p_rows is not null and jsonb_typeof(p_rows) = 'array'
    and jsonb_array_length(p_rows) = 0 then
    delete from public.entries where dataset_id = p_dataset;
    return 0;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be an array of {data, geometry?, geometryType?, geometrySourcePath?}';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) el
    where jsonb_typeof(el) is distinct from 'object'
       or jsonb_typeof(el -> 'data') is distinct from 'object'
  ) then
    raise exception 'p_rows elements must be objects with an object "data"';
  end if;

  -- One SQL statement: payload → entries (ids generated up front so the
  -- geometry insert can correlate without a second round trip) → geometries.
  -- The FK from geometries.entry_id is checked at end of statement, after
  -- both inserts have applied. Summaries and search vectors are maintained
  -- by the triggers.
  with payload as (
    select
      x.data,
      x.geometry,
      coalesce(x."geometryType", x.geometry_type) as geometry_type,
      coalesce(x."geometrySourcePath", x.geometry_source_path) as source_path,
      x."geometrySourceBytes" as source_bytes,
      x.bbox
    from jsonb_to_recordset(p_rows) as x(
      data                  jsonb,
      geometry              jsonb,
      geometry_type         text,
      "geometryType"        text,
      geometry_source_path  text,
      "geometrySourcePath"  text,
      "geometrySourceBytes" bigint,
      bbox                  double precision[]
    )
  ),
  with_ids as (
    select gen_random_uuid() as entry_id, p.* from payload p
  ),
  ins_entries as (
    insert into public.entries (id, dataset_id, data, geometry_type, created_by)
    select
      w.entry_id,
      p_dataset,
      w.data,
      coalesce(w.geometry_type, w.geometry ->> 'type'),
      auth.uid()
    from with_ids w
    returning 1
  ),
  ins_geometries as (
    insert into public.geometries
      (dataset_id, entry_id, source, source_path, source_bytes, type, bbox, created_by)
    select
      p_dataset,
      w.entry_id,
      w.geometry,
      w.source_path,
      w.source_bytes,
      coalesce(w.geometry_type, w.geometry ->> 'type'),
      w.bbox,
      auth.uid()
    from with_ids w
    where w.geometry is not null or w.source_path is not null
  )
  select count(*) into v_count from ins_entries;

  -- Progress reporting (§5.3): bump the dataset's most recent open import
  -- row, if the caller opened one. RLS (can_edit_dataset on imports) gates
  -- this write; a direct RPC use without an import row is a no-op.
  update public.imports im
  set processed = im.processed + v_count,
      status = case when im.status = 'pending' then 'processing' else im.status end
  where im.id = (
    select i.id
    from public.imports i
    where i.dataset_id = p_dataset
      and i.status in ('pending', 'processing')
    order by i.created_at desc
    limit 1
  );

  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- §5.5 — dataset_rows_for_tiles (SECURITY INVOKER)
-- ---------------------------------------------------------------------------

create function public.dataset_rows_for_tiles(
  p_dataset uuid,
  p_cursor  text    default null,
  p_limit   integer default 5000
)
returns table (
  entry_id uuid, data jsonb, geometry jsonb, geometry_source_path text,
  geometry_type text, bbox double precision[], next_cursor text
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_cursor_id uuid;
  v_limit     integer;
  v_ids       uuid[];
  v_datas     jsonb[];
  v_sources   jsonb[];
  v_paths     text[];
  v_gtypes    text[];
  v_bboxes    double precision[][];
  v_next_id   uuid;
  v_next      text;
begin
  -- Keyset by entry id. next_cursor follows the §5 intro blanket rule
  -- ("every RPC that pages returns next_cursor, null = exhausted") — the
  -- store's PagedRpcRow reads it off the last row, so exhaustion can never
  -- depend on the short-page convention alone.
  if p_cursor is not null then
    begin
      v_cursor_id := (convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb ->> 'i')::uuid;
    exception when others then
      raise exception 'invalid cursor';
    end;
    if v_cursor_id is null then
      raise exception 'invalid cursor';
    end if;
  end if;

  -- One extra row beyond p_limit decides exhaustion, exactly like §5.1; the
  -- cursor payload is the same opaque base64 {"i": "<entry uuid>"} shape.
  v_limit := greatest(1, coalesce(p_limit, 5000));

  select array_agg(q.entry_id), array_agg(q.data), array_agg(q.geometry),
         array_agg(q.geometry_source_path), array_agg(q.geometry_type), array_agg(q.bbox),
         (array_agg(q.entry_id))[v_limit + 1]
  into v_ids, v_datas, v_sources, v_paths, v_gtypes, v_bboxes, v_next_id
  from (
    select e.id as entry_id, e.data, g.source as geometry,
           g.source_path as geometry_source_path, e.geometry_type, g.bbox
    from public.entries e
    join public.geometries g on g.entry_id = e.id
    where e.dataset_id = p_dataset
      and (v_cursor_id is null or e.id > v_cursor_id)
    order by e.id
    limit v_limit + 1
  ) q;

  -- The (p_limit+1)th row only decides exhaustion; the cursor encodes the
  -- LAST EMITTED row's id (the p_limit-th), exactly as §5.1's
  -- "next_cursor is the LAST RETURNED row's sort tuple" rule does — encoding
  -- the probe row would swallow one real row per page.
  if v_next_id is not null then
    v_next := encode(
      convert_to(jsonb_build_object('i', v_ids[v_limit])::text, 'utf8'), 'base64');
  end if;

  -- Emit at most p_limit rows: the (p_limit+1)th only decided exhaustion.
  for i in 1 .. least(v_limit, coalesce(array_length(v_ids, 1), 0)) loop
    entry_id             := v_ids[i];
    data                 := v_datas[i];
    geometry             := v_sources[i];
    geometry_source_path := v_paths[i];
    geometry_type        := v_gtypes[i];
    bbox                 := v_bboxes[i];
    next_cursor          := v_next;
    return next;
  end loop;
end $$;

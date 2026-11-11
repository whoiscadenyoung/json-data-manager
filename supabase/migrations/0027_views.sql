-- Views: schema, two-phase runner RPCs, previews and staleness (issue #300 —
-- the Views initiative's second step; ADR 0028, docs/views-design.md §7/§10).
--
-- A view is a dataset (`datasets.kind = 'view'`) whose rows come from a saved
-- definition. The definition is compiled to ONE SELECT by the TypeScript
-- compiler (@caden/data-core, #299); this migration owns everything that
-- touches Postgres:
--
--   §1  datasets gains kind / definition / refresh_mode / output_settings /
--       data_version. Clients can never INSERT a view directly (restrictive
--       policy) nor UPDATE its definition columns (the 0003 column-grant
--       list simply does not name them): views are born and saved through
--       create_view / save_view (§6).
--   §2  data_version is bumped by the EXISTING statement-level entries /
--       geometries maintenance triggers (re-issued here with one more
--       column, so a statement costs one datasets UPDATE, not two).
--   §3  Row-write guard: entries / geometries of a view dataset can only be
--       written by the runner (view_apply_run) — import_entries, direct
--       inserts, row edits and even admin writes all refuse. Statement-level
--       transition-table triggers, one per event (the 0003 restriction).
--   §4  view_inputs + view_runs (+ RLS).
--   §5  The two-phase runner's database half. Phase 1 (compile + execute the
--       user-derived SELECT) runs in the SERVER-SIDE runner (app/src/server/
--       views) over a READ ONLY, RLS-scoped transaction — no SQL-taking RPC
--       exists. Phase 2 is view_apply_run / view_record_failure (SECURITY
--       DEFINER; they take ROWS as data and execute no user SQL), executable
--       ONLY by the dedicated `view_runner` role, never by authenticated.
--   §6  Save path: create_view / save_view — rewrite view_inputs, refuse
--       cycles, require can_view_dataset on every input.
--   §7  Staleness: view_stale(datasets) is a PostgREST computed column, so
--       the catalog summary select reads it as a plain field.
--
-- Visibility (design §10, the proposed default, implemented as written):
--   * saved rows of a view follow the VIEW dataset's own gates;
--   * saving or running a view requires can_view_dataset on EVERY input
--     (drafts included — there is no lifecycle gate, an unpublished project
--     draft is a valid input);
--   * live reads (later) run as the invoker.
--   * run history (view_runs) carries diagnostics, which hold sample VALUES
--     from the inputs (unmatched keys), so it is readable by the view's
--     editors and creator only, not by every viewer of the view.

-- ---------------------------------------------------------------------------
-- §1 — datasets columns
-- ---------------------------------------------------------------------------

alter table public.datasets
  add column kind            text   not null default 'source'
    check (kind in ('source', 'view')),
  add column definition      jsonb,
  add column refresh_mode    text
    check (refresh_mode in ('manual', 'auto', 'live')),
  add column output_settings jsonb,
  -- Monotonic change counter for the dataset's rows (entries AND
  -- geometries), bumped per write STATEMENT by the §2 triggers. Separate
  -- from map_tile_cache_version, which only tracks geometry.
  add column data_version    bigint not null default 0;

-- Shape: a view carries a definition and a refresh mode; a source carries
-- neither. (kind = 'view') = (x is not null) is "required iff view".
alter table public.datasets
  add constraint datasets_view_shape_check check (
    (kind = 'view') = (definition is not null)
    and (kind = 'view') = (refresh_mode is not null)
  );

create function public.datasets_view_defaults() returns trigger
language plpgsql as $$
begin
  if new.kind = 'view' and new.refresh_mode is null then
    new.refresh_mode := 'manual';
  end if;
  return new;
end $$;

create trigger datasets_view_defaults before insert on public.datasets
  for each row execute function public.datasets_view_defaults();

-- A client INSERT may only create a source. Views come from create_view
-- (SECURITY DEFINER, so it is not subject to this policy).
create policy "datasets insert: sources only"
  on public.datasets as restrictive for insert to authenticated
  with check (kind = 'source');

-- ---------------------------------------------------------------------------
-- §2 — data_version maintenance (the 0003 functions, one more column)
-- ---------------------------------------------------------------------------

create or replace function public.datasets_maintain_entries() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    update public.datasets d
    set entry_count = d.entry_count + x.n,
        data_version = d.data_version + 1
    from (select t.dataset_id, count(*) as n from new_entries t group by t.dataset_id) x
    where d.id = x.dataset_id;
  elsif tg_op = 'DELETE' then
    update public.datasets d
    set entry_count = greatest(d.entry_count - x.n, 0),
        data_version = d.data_version + 1
    from (select t.dataset_id, count(*) as n from old_entries t group by t.dataset_id) x
    where d.id = x.dataset_id;
  elsif tg_op = 'UPDATE' then
    -- Content changed; keep the dataset's updated_at fresh.
    update public.datasets d
    set updated_at = now(),
        data_version = d.data_version + 1
    where d.id in (select t.dataset_id from new_entries t);
  end if;
  return null;
end $$;

create or replace function public.datasets_maintain_geometries() returns trigger
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
        data_version = d.data_version + 1,
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
             -- st_makeenvelope from the row extents, never st_envelope (which
             -- degenerates to POINT/LINESTRING for single-point extents and
             -- the Polygon-typmod column refuses it; see 0003).
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
        map_tile_cache_version = d.map_tile_cache_version + 1,
        data_version = d.data_version + 1
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

-- ---------------------------------------------------------------------------
-- §3 — the row-write guard. SECURITY DEFINER so it can read datasets whoever
-- writes. The runner's own writes carry a transaction-bound token
-- (`jdm.view_write` = '<view id>:<xid>', set LOCAL by view_apply_run): a
-- session-level GUC planted earlier on a pooled connection can never match a
-- later transaction's xid.
--
-- Cascade deletes (dropping the view dataset itself) pass: by the time the
-- RI cascade statement's AFTER STATEMENT trigger runs, the parent datasets
-- row is already deleted and no longer visible here, so it is not a 'view'.
-- ---------------------------------------------------------------------------

create function public.view_assert_run_token(p_view uuid) returns void
language plpgsql stable set search_path = public as $$
begin
  if current_setting('jdm.view_write', true)
     is distinct from p_view::text || ':' || txid_current()::text then
    raise exception 'dataset % is a view: its rows are written only by its run', p_view
      using errcode = '42501';
  end if;
end $$;

create function public.view_rows_write_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_view uuid;
begin
  -- One loop per event (INSERT has no old_rows, DELETE no new_rows). The
  -- cheap datasets lookup runs first: a statement that touches no view
  -- dataset (every import and row edit on a source) never evaluates the
  -- token expression.
  if tg_op = 'INSERT' then
    for v_view in
      select d.id from public.datasets d
      where d.kind = 'view' and d.id in (select t.dataset_id from new_rows t)
    loop
      perform public.view_assert_run_token(v_view);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_view in
      select d.id from public.datasets d
      where d.kind = 'view' and d.id in (select t.dataset_id from old_rows t)
    loop
      perform public.view_assert_run_token(v_view);
    end loop;
  else
    for v_view in
      select d.id from public.datasets d
      where d.kind = 'view'
        and (d.id in (select t.dataset_id from new_rows t)
             or d.id in (select t.dataset_id from old_rows t))
    loop
      perform public.view_assert_run_token(v_view);
    end loop;
  end if;
  return null;
end $$;

create trigger entries_view_guard_insert
after insert on public.entries
referencing new table as new_rows
for each statement execute function public.view_rows_write_guard();
create trigger entries_view_guard_update
after update on public.entries
referencing old table as old_rows new table as new_rows
for each statement execute function public.view_rows_write_guard();
create trigger entries_view_guard_delete
after delete on public.entries
referencing old table as old_rows
for each statement execute function public.view_rows_write_guard();

create trigger geometries_view_guard_insert
after insert on public.geometries
referencing new table as new_rows
for each statement execute function public.view_rows_write_guard();
create trigger geometries_view_guard_update
after update on public.geometries
referencing old table as old_rows new table as new_rows
for each statement execute function public.view_rows_write_guard();
create trigger geometries_view_guard_delete
after delete on public.geometries
referencing old table as old_rows
for each statement execute function public.view_rows_write_guard();

-- ---------------------------------------------------------------------------
-- §4 — view_inputs, view_runs
-- ---------------------------------------------------------------------------

-- Rewritten on every save (§6). Drives lineage, cycle checks, staleness and
-- the "Used by" lists. input_dataset_id is NO ACTION: deleting an input that
-- a view still reads is refused, unless the view goes in the same statement.
create table public.view_inputs (
  view_id          uuid not null references public.datasets on delete cascade,
  input_dataset_id uuid not null references public.datasets,
  alias            text not null check (alias <> ''),
  -- A pinned input reads that frozen version's rows instead of the live ones.
  pinned_version   uuid references public.dataset_versions,
  primary key (view_id, alias),
  check (input_dataset_id <> view_id)
);
create index view_inputs_by_input on public.view_inputs (input_dataset_id);

create table public.view_runs (
  id             uuid primary key default gen_random_uuid(),
  view_id        uuid not null references public.datasets on delete cascade,
  status         text not null check (status in ('ok', 'error')),
  started_at     timestamptz not null,
  -- clock_timestamp, not now(): two runs inside one transaction (tests,
  -- a server function) must still order, and "latest ok run" depends on it.
  finished_at    timestamptz not null default clock_timestamp(),
  row_count      integer,
  -- { "<input dataset id>": <data_version captured BEFORE the read> }.
  input_versions jsonb not null default '{}'::jsonb,
  -- md5 of the definition the run executed; a changed definition is stale.
  definition_hash text,
  diagnostics    jsonb,
  error          text,
  created_by     uuid references public.profiles(id)
);
create index view_runs_by_view on public.view_runs (view_id, finished_at desc);
create index view_runs_last_ok on public.view_runs (view_id, finished_at desc)
  where status = 'ok';

-- The immutability rule of the version tables: every mutation goes through
-- the definer RPCs below (the supabase default privileges grant ALL).
revoke insert, update, delete, truncate, references, trigger
  on public.view_inputs, public.view_runs
  from anon, authenticated, service_role;
revoke select on public.view_inputs, public.view_runs from anon;

-- Run history is for editors and the creator (diagnostics carry sample input
-- values). The helper is definer: a policy ON view_runs must read OTHER
-- tables only (the 0018 recursion lesson), and datasets is one.
create function public.view_run_readable(p_view uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select auth.uid() is not null and (
    public.can_edit_dataset(p_view)
    or exists (select 1 from public.datasets d where d.id = p_view and d.created_by = auth.uid())
  );
$$;

alter table public.view_inputs enable row level security;
alter table public.view_runs   enable row level security;

create policy "view_inputs select: the view is viewable"
  on public.view_inputs for select to authenticated
  using (public.can_view_dataset(view_id));

create policy "view_runs select: editors and the creator"
  on public.view_runs for select to authenticated
  using (public.view_run_readable(view_id));

-- ---------------------------------------------------------------------------
-- §5 — the two-phase runner
-- ---------------------------------------------------------------------------

-- The write gate shared by the phase-1 version capture and phase 2: a view,
-- editable by the caller, whose every input the caller can view (no
-- lifecycle gate — an unpublished project draft is a valid input).
create function public.view_assert_runnable(p_view uuid) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_input uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to run a view' using errcode = '42501';
  end if;
  if not exists (select 1 from public.datasets d where d.id = p_view and d.kind = 'view') then
    raise exception 'dataset % is not a view', p_view using errcode = 'P0002';
  end if;
  if not public.can_edit_dataset(p_view) then
    raise exception 'view % is not writable by the caller', p_view using errcode = '42501';
  end if;
  if not exists (select 1 from public.view_inputs where view_id = p_view) then
    raise exception 'view % has no inputs', p_view;
  end if;
  for v_input in select vi.input_dataset_id from public.view_inputs vi where vi.view_id = p_view loop
    if not public.can_view_dataset(v_input) then
      raise exception 'input dataset % is not visible to the caller', v_input
        using errcode = '42501';
    end if;
  end loop;
end $$;

-- Phase 1, step 1: the gate + each input's current data_version, captured
-- BEFORE the read. A write racing the read leaves the recorded version older
-- than the rows, so the run reads as stale afterwards — never falsely fresh.
create function public.view_input_versions(p_view uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.view_assert_runnable(p_view);
  return (
    select coalesce(jsonb_object_agg(i.id::text, i.data_version), '{}'::jsonb)
    from public.view_inputs vi
    join public.datasets i on i.id = vi.input_dataset_id
    where vi.view_id = p_view
  );
end $$;

-- Phase 2: replace the view's rows with the ferried result, in ONE write
-- transaction that executes no user SQL. p_rows is [{row_id, d, geom}].
--
-- Rows are diffed by a deterministic entry id (md5 of view + source row id +
-- occurrence), so a re-run touches only changed rows: no RI churn on a 100k
-- row view (docs/memory/int-test-db-split-ri-teardown.md), and the tile cache
-- version only bumps when geometry actually changed.
create function public.view_apply_run(
  p_view           uuid,
  p_rows           jsonb,
  p_input_versions jsonb,
  p_diagnostics    jsonb default null,
  p_started_at     timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run      uuid;
  v_count    integer;
  v_props    jsonb;
  v_types    text[];
  v_def_hash text;
begin
  perform public.view_assert_runnable(p_view);
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be an array of {row_id, d, geom}';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) el
    where jsonb_typeof(el -> 'd') is distinct from 'object'
  ) then
    raise exception 'p_rows elements must carry an object "d"';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('jdm.view_run:' || p_view::text, 0));
  perform set_config('jdm.view_write', p_view::text || ':' || txid_current()::text, true);

  drop table if exists pg_temp.jdm_view_stage;
  create temp table jdm_view_stage on commit drop as
  select md5(p_view::text || ':' || coalesce(s.row_id::text, '') || ':'
             || (row_number() over (partition by s.row_id order by s.ord))::text)::uuid as id,
         s.ord, s.d,
         case when jsonb_typeof(s.geom) = 'object' then s.geom end as geom
  from (
    select e.ord,
           nullif(e.v ->> 'row_id', '')::uuid as row_id,
           e.v -> 'd' as d,
           e.v -> 'geom' as geom
    from jsonb_array_elements(p_rows) with ordinality as e(v, ord)
  ) s;
  create index on jdm_view_stage (id);
  analyze jdm_view_stage;

  select count(*) into v_count from jdm_view_stage;

  -- Declared property keys, then the geometry summary, BEFORE the rows: the
  -- search trigger reads datasets.properties and a changed list re-indexes
  -- the rows that already exist (0006's reindex trigger).
  select coalesce(jsonb_agg(q.k order by q.first_ord), '[]'::jsonb) into v_props
  from (
    select k, min(s.ord) as first_ord
    from jdm_view_stage s, jsonb_object_keys(s.d) k
    group by k
  ) q;
  select array_agg(distinct s.geom ->> 'type') into v_types
  from jdm_view_stage s where s.geom is not null;
  update public.datasets
  set properties = v_props,
      is_geospatial = coalesce(cardinality(v_types), 0) > 0,
      geometry_type = case when cardinality(v_types) = 1 then v_types[1] end
  where id = p_view;

  delete from public.entries e
  where e.dataset_id = p_view
    and not exists (select 1 from jdm_view_stage s where s.id = e.id);
  delete from public.geometries g
  where g.dataset_id = p_view
    and not exists (select 1 from jdm_view_stage s where s.id = g.entry_id and s.geom is not null);

  insert into public.entries (id, dataset_id, data, geometry_type, created_by)
  select s.id, p_view, s.d, s.geom ->> 'type', auth.uid()
  from jdm_view_stage s
  on conflict (id) do update
    set data = excluded.data, geometry_type = excluded.geometry_type
    where public.entries.dataset_id = excluded.dataset_id
      and (public.entries.data, public.entries.geometry_type)
          is distinct from (excluded.data, excluded.geometry_type);

  -- bbox = null on update: the maintenance trigger refills a null bbox.
  insert into public.geometries (dataset_id, entry_id, source, type, created_by)
  select p_view, s.id, s.geom, s.geom ->> 'type', auth.uid()
  from jdm_view_stage s
  where s.geom is not null
  on conflict (entry_id) do update
    set source = excluded.source, type = excluded.type, bbox = null
    where (public.geometries.source, public.geometries.type)
          is distinct from (excluded.source, excluded.type);

  select md5(d.definition::text) into v_def_hash from public.datasets d where d.id = p_view;
  insert into public.view_runs
    (view_id, status, started_at, row_count, input_versions, definition_hash, diagnostics, created_by)
  values
    (p_view, 'ok', coalesce(p_started_at, now()), v_count,
     coalesce(p_input_versions, '{}'::jsonb), v_def_hash, p_diagnostics, auth.uid())
  returning id into v_run;

  perform public.view_prune_runs(p_view);
  perform set_config('jdm.view_write', '', true);
  return v_run;
end $$;

-- Keeps the last 50 runs per view (the design's "run history" open question:
-- bounded, not unbounded).
create function public.view_prune_runs(p_view uuid) returns void
language sql security definer set search_path = public, extensions as $$
  delete from public.view_runs r
  where r.view_id = p_view
    and r.id not in (
      select x.id from public.view_runs x
      where x.view_id = p_view
      order by x.finished_at desc, x.id
      limit 50
    );
$$;

-- A failed run: recorded, rows untouched. Needs only an editable view (an
-- invisible input is itself a legitimate thing to record).
create function public.view_record_failure(
  p_view           uuid,
  p_error          text,
  p_started_at     timestamptz default null,
  p_input_versions jsonb default null,
  p_diagnostics    jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run uuid;
begin
  if auth.uid() is null
     or not exists (select 1 from public.datasets d where d.id = p_view and d.kind = 'view')
     or not public.can_edit_dataset(p_view) then
    raise exception 'view % is not writable by the caller', p_view using errcode = '42501';
  end if;
  insert into public.view_runs
    (view_id, status, started_at, input_versions, definition_hash, diagnostics, error, created_by)
  select p_view, 'error', coalesce(p_started_at, now()),
         coalesce(p_input_versions, '{}'::jsonb), md5(d.definition::text), p_diagnostics,
         left(coalesce(p_error, 'unknown error'), 4000), auth.uid()
  from public.datasets d where d.id = p_view
  returning id into v_run;
  perform public.view_prune_runs(p_view);
  return v_run;
end $$;

-- Invoker reads the runner needs to compile: the saved definition with its
-- inputs (a pin is reported as the version's durable `ref`), and input metadata (title + declared fields) for the compiler.
create function public.view_definition(p_view uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select jsonb_build_object(
    'definition', d.definition,
    'refreshMode', d.refresh_mode,
    'outputSettings', d.output_settings,
    'inputs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'alias', vi.alias, 'datasetId', vi.input_dataset_id,
               'pinnedVersion', pv.ref) order by vi.alias)
      from public.view_inputs vi
      left join public.dataset_versions pv on pv.id = vi.pinned_version
      where vi.view_id = d.id), '[]'::jsonb))
  from public.datasets d
  where d.id = p_view and d.kind = 'view';
$$;

-- p_inputs: [{alias, datasetId, pinnedVersion?}] → the same with title and
-- declared field names added (RLS-filtered: an input the caller cannot see
-- comes back without a title).
create function public.view_input_meta(p_inputs jsonb) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(
           el || jsonb_build_object('title', d.title, 'fields', coalesce(d.properties, '[]'::jsonb))
           order by e.ord), '[]'::jsonb)
  from jsonb_array_elements(p_inputs) with ordinality as e(el, ord)
  left join public.datasets d on d.id = (e.el ->> 'datasetId')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- §6 — the save path
-- ---------------------------------------------------------------------------

-- Rewrites view_inputs for a view. SECURITY DEFINER because the table has no
-- client write grants; every check is restated here:
--   * a view needs at least one input, aliases are unique non-empty strings;
--   * the caller can view every input (drafts included);
--   * a pinned version exists and belongs to its input (accepts the version
--     id or its durable ref);
--   * no cycle — walking view_inputs from the new inputs never reaches the
--     view itself (the walk sees ALL views, not only the caller's).
create function public.view_set_inputs(p_view uuid, p_inputs jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_el      jsonb;
  v_input   uuid;
  v_alias   text;
  v_pin     text;
  v_pin_id  uuid;
begin
  if p_inputs is null or jsonb_typeof(p_inputs) is distinct from 'array'
     or jsonb_array_length(p_inputs) = 0 then
    raise exception 'a view needs at least one input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('jdm.view_graph', 0));
  delete from public.view_inputs where view_id = p_view;

  for v_el in select value from jsonb_array_elements(p_inputs) loop
    v_alias := v_el ->> 'alias';
    v_input := (v_el ->> 'datasetId')::uuid;
    v_pin := nullif(v_el ->> 'pinnedVersion', '');
    if v_alias is null or v_alias = '' or v_input is null then
      raise exception 'each input needs an alias and a datasetId';
    end if;
    if v_input = p_view then
      raise exception 'a view cannot read itself (cycle)' using errcode = '23514';
    end if;
    if not public.can_view_dataset(v_input) then
      raise exception 'input dataset % is not visible to the caller', v_input
        using errcode = '42501';
    end if;
    v_pin_id := null;
    if v_pin is not null then
      select v.id into v_pin_id from public.dataset_versions v
      where v.dataset_id = v_input and (v.id::text = v_pin or v.ref = v_pin);
      if v_pin_id is null then
        raise exception 'pinned version % does not belong to dataset %', v_pin, v_input;
      end if;
    end if;
    insert into public.view_inputs (view_id, input_dataset_id, alias, pinned_version)
    values (p_view, v_input, v_alias, v_pin_id);
  end loop;

  -- Cycle: can the view be reached from its own inputs? (union dedupes, so
  -- the recursion terminates even on an existing cycle.)
  if exists (
    with recursive reach(id) as (
      select vi.input_dataset_id from public.view_inputs vi where vi.view_id = p_view
      union
      select vi.input_dataset_id
      from public.view_inputs vi join reach r on vi.view_id = r.id
    )
    select 1 from reach where id = p_view
  ) then
    raise exception 'saving this view would create a cycle' using errcode = '23514';
  end if;
end $$;

create function public.create_view(
  p_title           text,
  p_definition      jsonb,
  p_inputs          jsonb,
  p_refresh_mode    text default 'manual',
  p_output_settings jsonb default null,
  p_lifecycle       text default 'draft',
  p_visibility      text default 'members',
  p_edit_policy     text default 'open',
  p_description     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to create a view' using errcode = '42501';
  end if;
  if p_definition is null or jsonb_typeof(p_definition) is distinct from 'object' then
    raise exception 'p_definition must be a JSON object';
  end if;
  insert into public.datasets
    (title, description, kind, definition, refresh_mode, output_settings,
     lifecycle, visibility, edit_policy, created_by)
  values
    (p_title, p_description, 'view', p_definition, coalesce(p_refresh_mode, 'manual'),
     p_output_settings, p_lifecycle, p_visibility, p_edit_policy, auth.uid())
  returning id into v_id;
  perform public.view_set_inputs(v_id, p_inputs);
  return v_id;
end $$;

create function public.save_view(
  p_view            uuid,
  p_definition      jsonb,
  p_inputs          jsonb,
  p_refresh_mode    text default null,
  p_output_settings jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.datasets d where d.id = p_view and d.kind = 'view') then
    raise exception 'dataset % is not a view', p_view using errcode = 'P0002';
  end if;
  if not public.can_edit_dataset(p_view) then
    raise exception 'view % is not writable by the caller', p_view using errcode = '42501';
  end if;
  if p_definition is null or jsonb_typeof(p_definition) is distinct from 'object' then
    raise exception 'p_definition must be a JSON object';
  end if;
  perform public.view_set_inputs(p_view, p_inputs);
  update public.datasets
  set definition = p_definition,
      refresh_mode = coalesce(p_refresh_mode, refresh_mode),
      output_settings = coalesce(p_output_settings, output_settings)
  where id = p_view;
end $$;

-- ---------------------------------------------------------------------------
-- §7 — staleness. A PostgREST computed column: select=...,stale:view_stale.
-- Stale = no successful run yet, OR the definition changed since the last
-- successful run, OR any live (unpinned) input's data_version differs from
-- the one recorded then. SECURITY DEFINER so it reads input versions the
-- caller may not be able to see (it leaks one boolean, never a row).
-- ---------------------------------------------------------------------------

create function public.view_stale(d public.datasets) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select case when d.kind <> 'view' then false else (
    r.id is null
    or r.definition_hash is distinct from md5(d.definition::text)
    or exists (
      select 1
      from public.view_inputs vi
      join public.datasets i on i.id = vi.input_dataset_id
      where vi.view_id = d.id
        and vi.pinned_version is null
        and (r.input_versions ->> vi.input_dataset_id::text) is distinct from i.data_version::text
    )
  ) end
  from (select 1) one
  left join lateral (
    select x.id, x.definition_hash, x.input_versions
    from public.view_runs x
    where x.view_id = d.id and x.status = 'ok'
    order by x.finished_at desc
    limit 1
  ) r on true;
$$;

-- ---------------------------------------------------------------------------
-- The server runner's role. `view_runner` (NOLOGIN) owns the only EXECUTE on
-- the two row-taking definer functions and may SET ROLE authenticated (the
-- runner acts as the verified user for phase 1). The server connects as a
-- login role that is a member of it (deploy/postgres/zz-supabase-roles.sh
-- creates `jdm_server`; a superuser connection also works for dev/tests).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'view_runner') then
    create role view_runner nologin;
  end if;
  grant authenticated to view_runner;
  if exists (select 1 from pg_roles where rolname = 'jdm_server') then
    grant view_runner to jdm_server;
  end if;
end $$;
grant usage on schema public to view_runner;

-- ---------------------------------------------------------------------------
-- Grants. The internal helpers stay private to the definers above.
-- ---------------------------------------------------------------------------

revoke all on function public.view_assert_run_token(uuid) from anon, authenticated, service_role, public;
revoke all on function public.view_assert_runnable(uuid) from anon, authenticated, service_role, public;
revoke all on function public.view_input_versions(uuid) from anon, authenticated, service_role, public;
revoke all on function public.view_apply_run(uuid, jsonb, jsonb, jsonb, timestamptz) from anon, authenticated, service_role, public;
revoke all on function public.view_prune_runs(uuid) from anon, authenticated, service_role, public;
revoke all on function public.view_record_failure(uuid, text, timestamptz, jsonb, jsonb) from anon, authenticated, service_role, public;
revoke all on function public.view_definition(uuid) from anon, authenticated, service_role, public;
revoke all on function public.view_input_meta(jsonb) from anon, authenticated, service_role, public;
revoke all on function public.view_set_inputs(uuid, jsonb) from anon, authenticated, service_role, public;
revoke all on function public.create_view(text, jsonb, jsonb, text, jsonb, text, text, text, text) from anon, authenticated, service_role, public;
revoke all on function public.save_view(uuid, jsonb, jsonb, text, jsonb) from anon, authenticated, service_role, public;
revoke all on function public.view_stale(public.datasets) from anon, authenticated, service_role, public;
revoke all on function public.view_run_readable(uuid) from anon, authenticated, service_role, public;

grant execute on function public.view_input_versions(uuid) to authenticated;
grant execute on function public.view_apply_run(uuid, jsonb, jsonb, jsonb, timestamptz) to view_runner;
grant execute on function public.view_record_failure(uuid, text, timestamptz, jsonb, jsonb) to view_runner;
grant execute on function public.view_definition(uuid) to authenticated;
grant execute on function public.view_input_meta(jsonb) to authenticated;
grant execute on function public.create_view(text, jsonb, jsonb, text, jsonb, text, text, text, text) to authenticated;
grant execute on function public.save_view(uuid, jsonb, jsonb, text, jsonb) to authenticated;
grant execute on function public.view_stale(public.datasets) to authenticated;
grant execute on function public.view_run_readable(uuid) to authenticated;

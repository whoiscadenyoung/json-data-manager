-- Stage 7 — bound datasets (docs/supabase-migration-design.md §3.6, §4, §13
-- "Stage 7"; GitHub issue #206). The §3.6 DDL sketch verbatim, plus the sync
-- engine's server half as SECURITY DEFINER RPCs, the weekly reconcile cron,
-- and the 0009-limitation hardening the stage's parity list carried.
--
-- TABLES (§3.6, column-for-column; the §4 matrix row "remote_sources,
-- dataset_bindings, binding_entries, sync_runs, commit_mirror,
-- dataset_activity" is implemented per table below):
--   remote_sources    — source registry + manifest checks (registry.ts,
--                       remoteSourceChecks parity)
--   dataset_bindings  — the binding registry: schema mapping, commit cursor,
--                       keep-N/pin retention, remote revision
--   binding_entries   — the idempotency key map, unique (binding_id, entry_key)
--   sync_runs         — the durable sync engine rows (commit-tail / reconcile
--                       / sync; collecting → applying → sweeping → completed
--                       /failed; chunk_index/row_offset/claim resume). Chunk
--                       blobs ride Storage (chunk_paths recorded on the run
--                       row) instead of Convex _storage ids — the sync-chunks
--                       bucket below.
--   commit_mirror     — the applied-commit mirror, unique (binding_id,
--                       foreign_commit_id); tag compare computes pairs on
--                       demand from these rows (tagDeltas is NOT carried)
--   dataset_activity  — the History-tab feed (cms/tables.ts datasetActivity)
--
-- DELIBERATELY NOT HERE: the foreign-domain tables (the cross-app PoC's
-- restaurants/locations stay Convex-side — the PG side stores bindings + sync
-- state only) and `apps` (the app builder's table, a separate stage-7
-- surface's migration).
--
-- RLS (§4 matrix): SELECT for authenticated on every table; writes split —
--   * dataset_bindings CRUD answers to can_edit_dataset(dataset_id) (the
--     matrix's "bindings' CRUD via can_edit_dataset of the bound dataset"),
--     and
--   * binding_entries / sync_runs / commit_mirror / dataset_activity /
--     remote_sources carry NO direct write policies: the sync engine is the
--     only writer, through the definer RPCs below ("sync engine only
--     (service_role / definer RPCs)") — made literal by the revoke, since
--     default privileges grant arwdDxt on new tables (the 0009 lesson). No
--     browser-INSERT path ⇒ the 0008 INSERT..RETURNING hazard has no surface
--     on these tables, and the one browser-writable table (dataset_bindings)
--     has a flat SELECT policy — no definer helper for a RETURNING to
--     evaluate on the new row.
-- The bound-dataset read-only rule (docs/bound-datasets-design.md §2: "bound
-- datasets are read-only here") lands as RESTRICTIVE policies on the DATA
-- tables (entries / geometries / imports): a dataset carrying the `source`
-- marker rejects direct row writes for everyone while can_edit_dataset stays
-- untouched — the Convex gate's split (entry writes rejected; metadata and
-- organization ops stay allowed) expressed additively, the 0003
-- "edit_policy flips are creator-only" restrictive-policy precedent. The sync
-- engine writes through the definer, which bypasses RLS entirely.
--
-- RPCs (the Convex sync engine's server half, app/convex/sources/sync.ts —
-- the browser client half lives in app/src/lib/store/bindings.ts): the engine
-- keeps its #127 invariants — reads never truncate (the CLIENT drains source
-- pages to the null cursor), the cursor rides the payload's last commit, one
-- consumer per run (the `claim` lease minted by the gated start/claim RPCs
-- and checked by every batch RPC), checkpoints move only forward, collects
-- fail cleanly within an attempt budget, counters increment where the ops are
-- recorded, an unmapped commit `update` never materializes (needs_reconcile →
-- completion schedules the repair pass), mirrors are idempotent on
-- (binding_id, foreign_commit_id), and the finalize sweep retires stale keys
-- SWEEP_BATCH at a time. Batch boundaries moved from Convex's scheduler hops
-- to client-driven RPC calls — the run rows and their guards are identical.
--
-- pg_cron (§16's "same-instance vs sidecar" — DECIDED HERE: same instance;
-- the §2 topology is one Postgres and pg_cron ships in its image): the weekly
-- job inserts a `reconcile` run row per binding (Mondays 09:00 UTC — the
-- Convex crons.ts cadence). A cron has no browser: the scheduled run is a
-- WORK ITEM the resumable engine picks up — the sync card surfaces scheduled
-- runs and the next client (store resumeDueRun) claims and drains it. That is
-- the durable-workflow shape the engine was built for; the deviation from
-- Convex (which scheduled the whole reconcile server-side) is possible there
-- because co-deployed sources were in-process queries, while PG's registered
-- sources are read by the client (store/sources.ts) — the server-side leg
-- ends at the work item. `binding_schedule_reconciles` schedules EVERY
-- binding: Convex skipped remote sources (their checks were user-initiated),
-- but the PG registry does not model transport server-side and a scheduled
-- full pass over a remote binding is harmless (it re-reads the layer and
-- no-ops on unchanged rows).
--
-- 0009-limitation hardening (the stage's parity list, item 5): publish_version
-- now REFUSES a dataset that carries storage-backed oversized geometries —
-- the re-emitted body is 0011's verbatim plus that one guard. The freeze
-- would otherwise silently drop their geometry (version_entries.geometry
-- null) — a "frozen" version that quietly lost rows is worse than a refused
-- freeze, so stage-5 consumers now refuse loudly AT PUBLISH (they can never
-- read a half-frozen chain). The alternative (a cron backfill reading
-- Storage) is impossible in this stack: Storage bytes live in the
-- storage-api's own volume, `storage.objects` carries metadata only, and no
-- SQL/cron path can read a Storage object's content.

-- ---------------------------------------------------------------------------
-- §3.6 — remote_sources (source registry + manifest checks)
-- ---------------------------------------------------------------------------

create table public.remote_sources (
  source              text primary key,
  checked_at          timestamptz,
  error               text,
  layer               jsonb,   -- last successful manifest read
  record_url_template text
);

-- ---------------------------------------------------------------------------
-- §3.6 — dataset_bindings (the binding registry)
-- ---------------------------------------------------------------------------

create table public.dataset_bindings (
  id                      uuid primary key default gen_random_uuid(),
  source                  text not null references public.remote_sources(source),
  dataset_id              uuid not null references public.datasets on delete cascade,
  schema_mapping          jsonb,
  last_applied_commit_id  text,
  last_applied_commit_seq bigint,
  last_synced_at          timestamptz,
  last_reconciled_at      timestamptz,
  keep_versions           integer,
  pinned_refs             text[] not null default '{}',
  source_updated_at       timestamptz,
  synced_entry_count      integer,
  remote_revision         bigint,
  remote_schema_version   text,
  created_at              timestamptz not null default now(),
  -- One binding per dataset: a registry invariant the Convex code kept by
  -- convention (find-or-create by source); the pairing `source` marker on
  -- datasets (migration 0003) makes it structural — a dataset carries ONE
  -- marker, so two bindings could only fight over it.
  unique (dataset_id)
);
create index bindings_by_source on public.dataset_bindings (source);

-- ---------------------------------------------------------------------------
-- §3.6 — binding_entries (the idempotency key map)
-- ---------------------------------------------------------------------------

create table public.binding_entries (
  id         uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.dataset_bindings on delete cascade,
  entry_key  text not null,
  entry_id   uuid not null references public.entries on delete cascade,
  seen_run   text,
  unique (binding_id, entry_key)
);
-- The unique constraint IS the by-(binding, key) index the engine's keyed
-- lookups and the finalize sweep need; no extra index.

-- ---------------------------------------------------------------------------
-- §3.6 — sync_runs (the durable sync engine rows)
-- ---------------------------------------------------------------------------

create table public.sync_runs (
  id               uuid primary key default gen_random_uuid(),
  binding_id       uuid not null references public.dataset_bindings on delete cascade,
  mode             text not null check (mode in ('commit-tail','reconcile','sync')),
  status           text not null check (status in ('collecting','applying','sweeping','completed','failed')),
  total            integer not null default 0,
  added            integer not null default 0,
  updated          integer not null default 0,
  removed          integer not null default 0,
  applied          integer not null default 0,
  chunk_index      integer not null default 0,
  row_offset       integer not null default 0,
  collect_attempts integer,
  claim            text,
  needs_reconcile  boolean,
  last_commit_id   text,
  last_seq         bigint,
  remote_revision  bigint,
  ops              jsonb not null default '[]',
  error            text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  last_progress_at timestamptz not null default now(),
  truncated        boolean not null default false,
  -- "Chunk blobs ride Storage (chunk paths recorded on the run row)" (§3.6):
  -- the client uploads each collected chunk to the sync-chunks bucket at
  -- <datasetId>/sync-runs/<runId>/<n>.json, records the paths here at
  -- mark_collected, fetches them back by path on apply, and deletes them at
  -- completion/failure (best-effort, as in sync.ts).
  chunk_paths      text[] not null default '{}'
);
create index sync_runs_by_binding on public.sync_runs (binding_id, started_at desc);

-- ---------------------------------------------------------------------------
-- §3.6 — commit_mirror (the applied-commit mirror; the History rail's data)
-- ---------------------------------------------------------------------------

create table public.commit_mirror (
  id                uuid primary key default gen_random_uuid(),
  binding_id        uuid not null references public.dataset_bindings on delete cascade,
  foreign_commit_id text not null,
  seq               bigint not null,
  message           text not null,
  ops               jsonb not null default '[]',
  at                timestamptz not null,
  applied_at        timestamptz not null default now(),
  unique (binding_id, foreign_commit_id)
);
create index commit_mirror_by_binding_seq on public.commit_mirror (binding_id, seq desc);

-- ---------------------------------------------------------------------------
-- §3.6 — dataset_activity (the History-tab feed)
-- ---------------------------------------------------------------------------

create table public.dataset_activity (
  id              uuid primary key default gen_random_uuid(),
  binding_id      uuid not null references public.dataset_bindings on delete cascade,
  kind            text check (kind in ('sync','reconcile')),
  added           integer not null default 0,
  updated         integer not null default 0,
  removed         integer not null default 0,
  entry_count     integer not null default 0,
  ops             jsonb not null default '[]',
  needs_reconcile boolean,
  synced_at       timestamptz not null,
  truncated       boolean
);
create index dataset_activity_by_binding on public.dataset_activity (binding_id, synced_at desc);

-- ---------------------------------------------------------------------------
-- §4 — RLS. SELECT: authenticated on every table (the matrix row). Writes:
-- dataset_bindings via can_edit_dataset of the bound dataset; everything else
-- engine-only through the definer RPCs (no direct write policies at all).
-- ---------------------------------------------------------------------------

alter table public.remote_sources   enable row level security;
alter table public.dataset_bindings enable row level security;
alter table public.binding_entries  enable row level security;
alter table public.sync_runs        enable row level security;
alter table public.commit_mirror    enable row level security;
alter table public.dataset_activity enable row level security;

create policy "remote_sources select: authenticated"
  on public.remote_sources for select to authenticated using (true);

create policy "dataset_bindings select: authenticated"
  on public.dataset_bindings for select to authenticated using (true);

-- Flat SELECT (above) + can_edit_dataset INSERT: a browser insert's RETURNING
-- evaluates the SELECT policy on the NEW row (the 0008 lesson) — that policy
-- is `using (true)`, so the read-back cannot fail on a row whose dataset the
-- writer can edit. Binding management stays an editor-level act; the marker
-- (datasets.source) is stamped by the definer bind RPC, never by a client
-- payload (the source column is outside 0003's UPDATE grant list).
create policy "dataset_bindings insert: can_edit_dataset"
  on public.dataset_bindings for insert to authenticated
  with check (public.can_edit_dataset(dataset_id));

create policy "dataset_bindings update: can_edit_dataset"
  on public.dataset_bindings for update to authenticated
  using (public.can_edit_dataset(dataset_id))
  with check (public.can_edit_dataset(dataset_id));

create policy "dataset_bindings delete: can_edit_dataset"
  on public.dataset_bindings for delete to authenticated
  using (public.can_edit_dataset(dataset_id));

-- Engine-owned tables: SELECT-only for browsers. The revoke below (the 0009
-- default-privilege lesson) makes the engine-only rule literal even with no
-- write policies.
create policy "binding_entries select: authenticated"
  on public.binding_entries for select to authenticated using (true);
create policy "sync_runs select: authenticated"
  on public.sync_runs for select to authenticated using (true);
create policy "commit_mirror select: authenticated"
  on public.commit_mirror for select to authenticated using (true);
create policy "dataset_activity select: authenticated"
  on public.dataset_activity for select to authenticated using (true);

revoke insert, update, delete, truncate, references, trigger
  on public.remote_sources, public.binding_entries, public.sync_runs,
     public.commit_mirror, public.dataset_activity
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The bound-dataset read-only rule (docs/bound-datasets-design.md §2) as
-- RESTRICTIVE policies on the data tables. can_edit_dataset is untouched:
-- metadata edits, binding CRUD, and delete stay open-dataset semantics (the
-- Convex gate's split), while every direct ROW write on a dataset carrying
-- the `source` marker is refused for everyone — the sync engine's definer
-- RPCs bypass RLS and are the only writer.
-- ---------------------------------------------------------------------------

create function public.is_bound_dataset(p_dataset uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset and d.source is not null
  );
$$;

create policy "entries write: bound datasets are read-only"
  on public.entries as restrictive for insert to authenticated
  with check (not public.is_bound_dataset(dataset_id));
create policy "entries write: bound datasets are read-only (update)"
  on public.entries as restrictive for update to authenticated
  using (not public.is_bound_dataset(dataset_id))
  with check (not public.is_bound_dataset(dataset_id));
create policy "entries write: bound datasets are read-only (delete)"
  on public.entries as restrictive for delete to authenticated
  using (not public.is_bound_dataset(dataset_id));

create policy "geometries write: bound datasets are read-only"
  on public.geometries as restrictive for insert to authenticated
  with check (not public.is_bound_dataset(dataset_id));
create policy "geometries write: bound datasets are read-only (update)"
  on public.geometries as restrictive for update to authenticated
  using (not public.is_bound_dataset(dataset_id))
  with check (not public.is_bound_dataset(dataset_id));
create policy "geometries write: bound datasets are read-only (delete)"
  on public.geometries as restrictive for delete to authenticated
  using (not public.is_bound_dataset(dataset_id));

create policy "imports write: bound datasets are read-only"
  on public.imports as restrictive for insert to authenticated
  with check (not public.is_bound_dataset(dataset_id));
create policy "imports write: bound datasets are read-only (update)"
  on public.imports as restrictive for update to authenticated
  using (not public.is_bound_dataset(dataset_id))
  with check (not public.is_bound_dataset(dataset_id));
create policy "imports write: bound datasets are read-only (delete)"
  on public.imports as restrictive for delete to authenticated
  using (not public.is_bound_dataset(dataset_id));

-- ---------------------------------------------------------------------------
-- Storage — the sync-chunks bucket (§3.6: chunk blobs ride Storage). Same
-- dataset-shaped policy shape as the earlier buckets: paths key their first
-- segment to the owning dataset (<datasetId>/sync-runs/<runId>/<n>.json), so
-- reads (the resuming client fetching a chunk back) require
-- can_view_dataset and writes/deletes require can_edit_dataset AND the
-- object's owner stamp — the 0006 HARDENED shape, NOT 0004's weaker
-- editor-only one: the policies below are the 0006 re-emission with
-- 'sync-chunks' added to their bucket lists (dropping the 0006 names first,
-- so the hardened owner-stamp requirement can never regress to the 0004
-- shape by a re-run of this file).
-- ---------------------------------------------------------------------------

do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice '0012: storage tables absent (no storage-api service in this environment) — sync-chunks bucket and object policies skipped';
  else
  insert into storage.buckets (id, name)
  values ('sync-chunks', 'sync-chunks')
  on conflict (id) do nothing;

  drop policy if exists "migrated dataset buckets: insert requires can_edit_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: update requires can_edit_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: delete requires can_edit_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: select requires can_view_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: insert requires editor + owner" on storage.objects;
  drop policy if exists "migrated dataset buckets: update requires editor + owner" on storage.objects;
  drop policy if exists "migrated dataset buckets: delete requires editor + owner" on storage.objects;

  create policy "migrated dataset buckets: select requires can_view_dataset"
    on storage.objects for select to authenticated
    using (
      bucket_id in ('geometries', 'source-files', 'tile-archives', 'sync-chunks')
      and public.can_view_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "migrated dataset buckets: insert requires editor + owner"
    on storage.objects for insert to authenticated
    with check (
      bucket_id in ('geometries', 'source-files', 'tile-archives', 'sync-chunks')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "migrated dataset buckets: update requires editor + owner"
    on storage.objects for update to authenticated
    using (
      bucket_id in ('geometries', 'source-files', 'tile-archives', 'sync-chunks')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    )
    with check (
      bucket_id in ('geometries', 'source-files', 'tile-archives', 'sync-chunks')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "migrated dataset buckets: delete requires editor + owner"
    on storage.objects for delete to authenticated
    using (
      bucket_id in ('geometries', 'source-files', 'tile-archives', 'sync-chunks')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    );
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- The sync engine's server half (app/convex/sources/sync.ts parity). All
-- SECURITY DEFINER with pinned search_path (the 0005 pattern: each definer
-- restates the gate it bypasses). EXECUTE: authenticated only (the default
-- PUBLIC grant would hand anon the RPC surface; the cron's caller is the
-- superuser, which execute revokes never bind).
-- ---------------------------------------------------------------------------

-- Engine constants (sync.ts's ACTIVITY_OPS_LIMIT / SWEEP_BATCH /
-- COMMIT_MIRROR_LIMIT / stale-run window / collect budget) as functions, so
-- the client half and the server share literal values only through the
-- module docs, never divergent copies in policy bodies.
create function public.binding_activity_ops_limit() returns integer
language sql immutable as $$
  select 200
$$;

create function public.binding_sweep_batch_size() returns integer
language sql immutable as $$
  select 100
$$;

create function public.binding_commit_mirror_limit() returns integer
language sql immutable as $$
  select 200
$$;

create function public.binding_stale_run_interval() returns interval
language sql immutable as $$
  select interval '2 minutes'
$$;

create function public.binding_max_collect_attempts() returns integer
language sql immutable as $$
  select 3
$$;

-- Bumps one integer counter of a tally (the running batch state jsonb).
create function public.binding_tally_bump(p_tally jsonb, p_field text, p_by integer)
returns jsonb
language sql immutable as $$
  select jsonb_set(p_tally, ARRAY[p_field],
    to_jsonb(coalesce((p_tally ->> p_field)::int, 0) + coalesce(p_by, 0)))
$$;

-- Appends one activity op to a tally until the cap, then sets truncated
-- (sync.ts's recordActivity — counters and the cap flag live in the same
-- jsonb so the cap and the flag can never disagree).
create function public.binding_record_op(
  p_tally jsonb, p_label text, p_op text, p_detail text default null
) returns jsonb
language plpgsql immutable as $$
begin
  if jsonb_array_length(coalesce(p_tally -> 'ops', '[]'::jsonb))
       < public.binding_activity_ops_limit() then
    return jsonb_set(coalesce(p_tally, '{}'::jsonb), '{ops}',
      coalesce(p_tally -> 'ops', '[]'::jsonb) || jsonb_build_object(
        'label', p_label, 'op', p_op, 'detail', p_detail));
  end if;
  return jsonb_set(coalesce(p_tally, '{}'::jsonb), '{truncated}', 'true'::jsonb);
end $$;

-- One row's activity label (sync.ts's rowLabel): label, then name, then key.
create function public.binding_row_label(p_data jsonb, p_key text) returns text
language sql immutable as $$
  select coalesce(
    case when jsonb_typeof(p_data -> 'label') = 'string' then p_data ->> 'label' end,
    case when jsonb_typeof(p_data -> 'name') = 'string' then p_data ->> 'name' end,
    p_key)
$$;

-- One commit op's label (sync.ts's opLabelFor): the first label/name field
-- carrying a string after- (then before-) value, else the op's entry key.
create function public.binding_op_label(p_op jsonb) returns text
language plpgsql immutable as $$
declare
  v_field jsonb;
begin
  if jsonb_typeof(p_op -> 'fields') = 'array' then
    for v_field in select * from jsonb_array_elements(p_op -> 'fields')
    loop
      if v_field ->> 'name' in ('label', 'name') then
        if jsonb_typeof(v_field -> 'after') = 'string' then
          return v_field ->> 'after';
        end if;
        if jsonb_typeof(v_field -> 'before') = 'string' then
          return v_field ->> 'before';
        end if;
      end if;
    end loop;
  end if;
  return p_op ->> 'entryKey';
end $$;

-- Field-level before→after detail for one updated row (sync.ts's
-- diffRowDetail — the History-tab detail string), computed over jsonb maps.
create function public.binding_row_detail(p_before jsonb, p_after jsonb) returns text
language plpgsql immutable as $$
declare
  v_key     text;
  v_changes text[] := '{}';
begin
  for v_key in
    select k from (
      select jsonb_object_keys(coalesce(p_before, '{}'::jsonb)) as k
      union
      select jsonb_object_keys(coalesce(p_after, '{}'::jsonb))
    ) keys
  loop
    if coalesce(p_before, '{}'::jsonb) -> v_key
         is distinct from coalesce(p_after, '{}'::jsonb) -> v_key then
      v_changes := v_changes || v_key || ': '
                   || coalesce(coalesce(p_before, '{}'::jsonb) ->> v_key, 'null')
                   || ' → '
                   || coalesce(coalesce(p_after, '{}'::jsonb) ->> v_key, 'null');
    end if;
  end loop;
  return case when array_length(v_changes, 1) = 0 then null
              else array_to_string(v_changes, '; ') end;
end $$;

-- One commit op's field-diff detail (sync.ts's detailFor): "name: before →
-- after" pairs, the lat/lng fields elided (they are the geometry's source,
-- not user-visible columns).
create function public.binding_op_detail(p_op jsonb) returns text
language plpgsql immutable as $$
declare
  v_field   jsonb;
  v_changes text[] := '{}';
begin
  if jsonb_typeof(p_op -> 'fields') is distinct from 'array' then
    return null;
  end if;
  for v_field in select * from jsonb_array_elements(p_op -> 'fields')
  loop
    if v_field ->> 'name' not in ('lat', 'lng') then
      v_changes := v_changes || (v_field ->> 'name' || ': '
        || coalesce(v_field ->> 'before', 'null') || ' → '
        || coalesce(v_field ->> 'after', 'null'));
    end if;
  end loop;
  return case when array_length(v_changes, 1) = 0 then null
              else array_to_string(v_changes, '; ') end;
end $$;

-- Builds a row's GeoJSON Point from the declared latLng mapping
-- (registry.ts LocalSource.buildGeometry's generic form): numeric
-- data[latKey]/data[lngKey] → {type: 'Point', coordinates: [lng, lat]};
-- anything else → null (the row has no geometry). A source whose geometry is
-- not lat/lng-derived cannot be rebuilt server-side — its commit tail flags
-- geometry_changed ops needs_reconcile (full passes carry final geometry).
create function public.binding_build_geometry(p_mapping jsonb, p_data jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_lat double precision;
  v_lng double precision;
begin
  if p_mapping is null or jsonb_typeof(p_mapping) is distinct from 'object'
    or (p_mapping -> 'geometry' ->> 'kind') is distinct from 'latLng'
    or p_data is null or jsonb_typeof(p_data) is distinct from 'object' then
    return null;
  end if;
  begin
    v_lat := (p_data -> (p_mapping -> 'geometry' ->> 'lat'))::double precision;
    v_lng := (p_data -> (p_mapping -> 'geometry' ->> 'lng'))::double precision;
  exception when others then
    return null;
  end;
  if v_lat is null or v_lng is null then
    return null;
  end if;
  return jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(v_lng, v_lat));
end $$;

-- The commit-tail apply leg (sync.ts's applyCommitOp): applies one commit op
-- to its keyed entry, recording the activity op and the counters. `delete`
-- drops the mapped entry and its map row (a delete for an already-unmapped
-- key is a no-op); `add` builds the entry from the op's after-values
-- (geometry rebuilt from the mapping); `update` merges the field deltas into
-- what's stored. An `update` whose key has no map row is NOT applied —
-- delta-only ops would create partial entries — the tally flags
-- needs_reconcile and completion schedules a full pass (#127 defect 6).
-- p_op: {entryKey, op, fields: [{name, before, after}], geometryChanged,
-- commitSeq} (commitSeq is folded in by the batch leg).
create function public.binding_apply_commit_op(
  p_binding public.dataset_bindings,
  p_run_id  uuid,
  p_tally   jsonb,
  p_op      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_mapping   public.binding_entries;
  v_entry     public.entries;
  v_base_data jsonb;
  v_field     jsonb;
  v_geometry  jsonb;
  v_tally     jsonb := coalesce(p_tally, '{}'::jsonb);
begin
  select * into v_mapping from public.binding_entries
    where binding_id = p_binding.id and entry_key = p_op ->> 'entryKey';

  if p_op ->> 'op' = 'delete' then
    if v_mapping.id is not null then
      delete from public.entries where id = v_mapping.entry_id;
      delete from public.binding_entries where id = v_mapping.id;
      v_tally := public.binding_tally_bump(v_tally, 'removed', 1);
    end if;
    return public.binding_record_op(v_tally, public.binding_op_label(p_op), 'remove');
  end if;

  if p_op ->> 'op' = 'update' and v_mapping.id is null then
    -- Never materialize a partial entry from a delta-only op.
    v_tally := jsonb_set(v_tally, '{needsReconcile}', 'true'::jsonb);
    return public.binding_record_op(
      v_tally, p_op ->> 'entryKey', 'update',
      'Key not in the projection — a full reconcile was scheduled to restore it.');
  end if;

  if p_op ->> 'op' = 'update' then
    select data into v_base_data from public.entries where id = v_mapping.entry_id;
  else
    v_base_data := '{}'::jsonb;
  end if;
  for v_field in select * from jsonb_array_elements(coalesce(p_op -> 'fields', '[]'::jsonb))
  loop
    v_base_data := jsonb_set(coalesce(v_base_data, '{}'::jsonb),
      ARRAY[v_field ->> 'name'], v_field -> 'after', true);
  end loop;

  v_geometry := case
    when (p_op ->> 'geometryChanged')::boolean is not distinct from true
      then public.binding_build_geometry(p_binding.schema_mapping, v_base_data)
    else null end;

  if v_mapping.id is null then
    insert into public.entries (dataset_id, data, geometry_type)
      values (p_binding.dataset_id, v_base_data, v_geometry ->> 'type')
      returning * into v_entry;
    insert into public.geometries (dataset_id, entry_id, source, type)
      select p_binding.dataset_id, v_entry.id, v_geometry, v_geometry ->> 'type'
      where v_geometry is not null and v_geometry ->> 'type' is not null;
    insert into public.binding_entries (binding_id, entry_key, entry_id, seen_run)
      values (p_binding.id, p_op ->> 'entryKey', v_entry.id,
              'commit:' || coalesce(p_op ->> 'commitSeq', '0'));
    v_tally := public.binding_tally_bump(v_tally, 'added', 1);
    return public.binding_record_op(v_tally,
      public.binding_row_label(v_base_data, p_op ->> 'entryKey'), 'add',
      public.binding_op_detail(p_op));
  end if;

  update public.entries
    set data = v_base_data,
        geometry_type = coalesce(v_geometry ->> 'type', geometry_type)
    where id = v_mapping.entry_id;
  if (p_op ->> 'geometryChanged')::boolean is not distinct from true then
    if v_geometry is null then
      delete from public.geometries where entry_id = v_mapping.entry_id;
    elsif v_geometry ->> 'type' is not null then
      insert into public.geometries (dataset_id, entry_id, source, type)
        values (p_binding.dataset_id, v_mapping.entry_id, v_geometry, v_geometry ->> 'type')
        on conflict (entry_id) do update
          set source = excluded.source, type = excluded.type,
              source_path = null, source_bytes = null, bbox = null;
    end if;
  end if;
  update public.binding_entries
    set seen_run = 'commit:' || coalesce(p_op ->> 'commitSeq', '0')
    where id = v_mapping.id;
  v_tally := public.binding_tally_bump(v_tally, 'updated', 1);
  return public.binding_record_op(v_tally,
    public.binding_row_label(v_base_data, p_op ->> 'entryKey'), 'update',
    public.binding_op_detail(p_op));
end $$;

-- Writes one row's geometry (the full-state leg's upsert): replaces the
-- stored geometry when the row carries one, deletes the row when it lost
-- it. bbox is nulled on replace so the statement trigger re-derives it from
-- the new geom (the trigger only fills NULL bboxes).
create function public.binding_write_geometry(
  p_dataset_id uuid, p_entry_id uuid, p_geometry jsonb
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_geometry is null then
    delete from public.geometries where entry_id = p_entry_id;
  elsif p_geometry ->> 'type' is not null then
    insert into public.geometries (dataset_id, entry_id, source, type)
      values (p_dataset_id, p_entry_id, p_geometry, p_geometry ->> 'type')
      on conflict (entry_id) do update
        set source = excluded.source, type = excluded.type,
            source_path = null, source_bytes = null, bbox = null;
  end if;
end $$;

-- The full-state apply leg (sync.ts's applyRow): one source row by key — a
-- key with no map row inserts (entry + geometry + map row), a dangling map
-- row gets its entry rebuilt, a mapped key patches only when its content
-- changed. Every map row is stamped with the run so the sweep can detect
-- deletes. p_row: {key, data, geometry?} (geometry absent/null = no geometry).
create function public.binding_apply_row(
  p_binding public.dataset_bindings,
  p_run_id  uuid,
  p_tally   jsonb,
  p_row     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_mapping  public.binding_entries;
  v_entry    public.entries;
  v_geometry jsonb := p_row -> 'geometry';
  v_row_data jsonb := p_row -> 'data';
  v_tally    jsonb := coalesce(p_tally, '{}'::jsonb);
  v_detail   text;
begin
  select * into v_mapping from public.binding_entries
    where binding_id = p_binding.id and entry_key = p_row ->> 'key';

  if v_mapping.id is null then
    insert into public.entries (dataset_id, data, geometry_type)
      values (p_binding.dataset_id, v_row_data, v_geometry ->> 'type')
      returning * into v_entry;
    perform public.binding_write_geometry(p_binding.dataset_id, v_entry.id, v_geometry);
    insert into public.binding_entries (binding_id, entry_key, entry_id, seen_run)
      values (p_binding.id, p_row ->> 'key', v_entry.id, p_run_id::text);
    v_tally := public.binding_tally_bump(v_tally, 'added', 1);
    return public.binding_record_op(v_tally,
      public.binding_row_label(v_row_data, p_row ->> 'key'), 'add');
  end if;

  -- Dangling map row (the entry was deleted out of band) — rebuild it.
  select * into v_entry from public.entries where id = v_mapping.entry_id;
  if v_entry.id is null then
    insert into public.entries (dataset_id, data, geometry_type)
      values (p_binding.dataset_id, v_row_data, v_geometry ->> 'type')
      returning * into v_entry;
    perform public.binding_write_geometry(p_binding.dataset_id, v_entry.id, v_geometry);
    update public.binding_entries
      set entry_id = v_entry.id, seen_run = p_run_id::text
      where id = v_mapping.id;
    v_tally := public.binding_tally_bump(v_tally, 'added', 1);
    return public.binding_record_op(v_tally,
      public.binding_row_label(v_row_data, p_row ->> 'key'), 'add');
  end if;

  if v_entry.data = v_row_data
    and (select source from public.geometries where entry_id = v_mapping.entry_id)
      is not distinct from v_geometry then
    -- Unchanged rows still stamp the map with the run so delete detection
    -- sees them as alive. (`is not distinct from`: a geometry-less row
    -- compares NULL = NULL — plain `=` would read as changed and re-update
    -- every unchanged row on every replay.)
    update public.binding_entries
      set seen_run = p_run_id::text
      where id = v_mapping.id;
    return v_tally;
  end if;

  v_detail := case when v_entry.data = v_row_data
    then null else public.binding_row_detail(v_entry.data, v_row_data) end;
  update public.entries
    set data = v_row_data,
        geometry_type = coalesce(v_geometry ->> 'type', geometry_type)
    where id = v_mapping.entry_id;
  perform public.binding_write_geometry(p_binding.dataset_id, v_mapping.entry_id, v_geometry);
  v_tally := public.binding_tally_bump(v_tally, 'updated', 1);
  return public.binding_record_op(v_tally,
    public.binding_row_label(v_row_data, p_row ->> 'key'), 'update', v_detail);
end $$;

-- Folds one batch's tally into its run row: counters accumulate, the
-- checkpoint moves only FORWARD (sync.ts's checkpointFields — a superseded
-- action replaying an older batch cannot drag the resume point back), the
-- ops array is capped, and truncated ORs.
create function public.binding_patch_run_batch(
  p_run_id uuid, p_tally jsonb, p_applied integer, p_chunk_index integer, p_row_offset integer
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run public.sync_runs;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null then
    return;
  end if;
  update public.sync_runs
    set added            = v_run.added + coalesce((p_tally ->> 'added')::int, 0),
        updated          = v_run.updated + coalesce((p_tally ->> 'updated')::int, 0),
        removed          = v_run.removed + coalesce((p_tally ->> 'removed')::int, 0),
        applied          = v_run.applied + coalesce(p_applied, 0),
        needs_reconcile  = coalesce((p_tally ->> 'needsReconcile')::boolean, v_run.needs_reconcile),
        ops              = coalesce(p_tally -> 'ops', v_run.ops),
        truncated        = v_run.truncated or coalesce((p_tally ->> 'truncated')::boolean, false),
        chunk_index      = case
          when p_chunk_index > v_run.chunk_index
            or (p_chunk_index = v_run.chunk_index and p_row_offset >= v_run.row_offset)
          then p_chunk_index else v_run.chunk_index end,
        row_offset       = case
          when p_chunk_index > v_run.chunk_index
            or (p_chunk_index = v_run.chunk_index and p_row_offset >= v_run.row_offset)
          then p_row_offset else v_run.row_offset end,
        last_progress_at = now()
    where id = p_run_id;
end $$;

-- The batch legs' shared run-state answer (the client's progress reads).
create function public.binding_run_state(p_run_id uuid) returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'added', added, 'updated', updated, 'removed', removed, 'applied', applied,
    'total', total, 'needsReconcile', needs_reconcile, 'truncated', truncated,
    'ops', ops, 'status', status, 'error', error,
    'chunkIndex', chunk_index, 'rowOffset', row_offset,
    'finishedAt', finished_at)
  from public.sync_runs where id = p_run_id
$$;

-- Finds the binding for a source, raising when absent — every gated RPC's
-- preamble; the error names the source, so a mistyped registry key reads as
-- configuration, not as a denied write.
create function public.binding_for_source(p_source text) returns public.dataset_bindings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_binding public.dataset_bindings;
begin
  select * into v_binding from public.dataset_bindings where source = p_source;
  if v_binding.id is null then
    raise exception 'No bound dataset for source %', p_source;
  end if;
  return v_binding;
end $$;

-- Find-or-create the bound dataset + binding row for one source
-- (sync.ts's ensureBoundDataset). The dataset is created from the client's
-- descriptor projection (the source registry is client-side —
-- store/sources.ts — so the server cannot look one up), marked read-only at
-- birth (datasets.source = {"name": p_source}), and the binding files the
-- schema mapping. p_dataset: {title, description?, jsonSchema, properties,
-- isGeospatial, geometryType?, groupId?}.
create function public.binding_ensure(
  p_source         text,
  p_dataset        jsonb,
  p_schema_mapping jsonb default null
) returns uuid            -- the binding row's id
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_binding public.dataset_bindings;
  v_dataset uuid;
begin
  if p_source is null or btrim(p_source) = '' then
    raise exception 'binding_ensure requires a non-empty source key';
  end if;
  if p_dataset is null or jsonb_typeof(p_dataset) is distinct from 'object'
    or coalesce(p_dataset ->> 'title', '') = '' then
    raise exception 'binding_ensure requires a dataset descriptor with a title';
  end if;
  -- The created dataset is born the caller's (datasets.created_by defaults to
  -- auth.uid()); an unauthenticated caller would fail that NOT NULL with a
  -- constraint error — name the real problem instead.
  if auth.uid() is null then
    raise exception 'binding_ensure requires a signed-in caller';
  end if;

  -- The registry row for the source (checked_at untouched — that is the
  -- manifest check's job); an unknown source cannot bind.
  insert into public.remote_sources (source) values (p_source)
  on conflict (source) do nothing;

  select * into v_binding from public.dataset_bindings where source = p_source;
  if v_binding.id is not null then
    update public.dataset_bindings
      set schema_mapping = coalesce(p_schema_mapping, schema_mapping)
      where id = v_binding.id;
    return v_binding.id;
  end if;

  insert into public.datasets
    (title, description, json_schema, properties, is_geospatial, geometry_type,
     group_id, source)
  values (
    p_dataset ->> 'title',
    nullif(p_dataset ->> 'description', ''),
    coalesce(p_dataset -> 'jsonSchema', '{}'::jsonb),
    coalesce(p_dataset -> 'properties', '[]'::jsonb),
    coalesce((p_dataset ->> 'isGeospatial')::boolean, false),
    nullif(p_dataset ->> 'geometryType', ''),
    (p_dataset ->> 'groupId')::uuid,
    jsonb_build_object('name', p_source))
  returning id into v_dataset;

  insert into public.dataset_bindings (source, dataset_id, schema_mapping)
  values (p_source, v_dataset, p_schema_mapping)
  returning id into v_binding;

  return v_binding.id;
end $$;

-- Starts (or joins) one durable sync run (sync.ts's startRun; the mode
-- decision moved client-side — the client knows the registered source's
-- transport and feed). The active-run guard joins a live run instead of
-- forking a second one; a run whose checkpoint went quiet longer than the
-- stale window is revived (claim rotated, attempt budget enforced), which is
-- what makes the cron's scheduled work items resumable through the same
-- entry point. The gate restates can_edit_dataset — a sync writes the bound
-- dataset's rows.
create function public.binding_start_run(
  p_source text,
  p_mode   text          -- 'commit-tail' | 'reconcile' | 'sync'
) returns table (run_id uuid, claim text, already_running boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_binding  public.dataset_bindings;
  v_run      public.sync_runs;
  v_claim    text;
  v_attempts integer;
begin
  if p_mode not in ('commit-tail', 'reconcile', 'sync') then
    raise exception 'binding_start_run: mode must be commit-tail, reconcile, or sync';
  end if;
  v_binding := public.binding_for_source(p_source);
  if not public.can_edit_dataset(v_binding.dataset_id) then
    raise exception 'binding_start_run: dataset is not writable by the caller';
  end if;

  select * into v_run from public.sync_runs
    where binding_id = v_binding.id and status in ('collecting', 'applying', 'sweeping')
    order by started_at desc limit 1;

  if v_run.id is not null then
    -- `return query` APPENDS without terminating (verified on the live
    -- stack: the join/revive answers were followed by a second, fresh-run
    -- row) — every early answer pairs with a bare `return`.
    if v_run.status = 'sweeping'
      or v_run.last_progress_at > now() - public.binding_stale_run_interval() then
      -- A live run joins instead of forking (the caller shows its progress;
      -- a null claim stays null — the sweep is server-claimed when the
      -- client resumes it).
      return query select v_run.id, coalesce(v_run.claim, ''), true;
      return;
    end if;
    -- A quiet checkpoint is a dead worker — revive it (rotate the lease).
    if v_run.status = 'collecting' then
      v_attempts := coalesce(v_run.collect_attempts, 1) + 1;
      if v_attempts > public.binding_max_collect_attempts() then
        update public.sync_runs
          set status = 'failed', finished_at = now(),
              error = 'Collect was scheduled ' || coalesce(v_run.collect_attempts, 1)::text
                      || ' times without completing; giving up on this run.'
          where id = v_run.id;
        -- Fall through: the caller's kickoff starts a fresh run.
      else
        v_claim := replace(gen_random_uuid()::text, '-', '');
        update public.sync_runs
          set claim = v_claim, collect_attempts = v_attempts, last_progress_at = now()
          where id = v_run.id;
        return query select v_run.id, v_claim, true;
        return;
      end if;
    else
      v_claim := replace(gen_random_uuid()::text, '-', '');
      update public.sync_runs
        set claim = v_claim, last_progress_at = now()
        where id = v_run.id;
      return query select v_run.id, v_claim, true;
      return;
    end if;
  end if;

  v_claim := replace(gen_random_uuid()::text, '-', '');
  insert into public.sync_runs (binding_id, mode, status, claim, collect_attempts)
  values (v_binding.id, p_mode, 'collecting', v_claim, 1)
  returning id into v_run;
  return query select v_run.id, v_claim, false;
end $$;

-- Claims a run this client will drive (the resume half of the lease): a
-- cron-scheduled run (claim null) or a stale active run rotates its claim to
-- the caller; a collecting run consumes one attempt of the budget (#127
-- defect 3). Null answer = nothing to claim (quiet completed/failed run,
-- budget spent, or a live run that still owns itself). The gate restates
-- can_edit_dataset.
create function public.binding_claim_run(p_run_id uuid) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run     public.sync_runs;
  v_binding public.dataset_bindings;
  v_claim   text;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status not in ('collecting', 'applying') then
    return null;
  end if;
  select * into v_binding from public.dataset_bindings where id = v_run.binding_id;
  if not public.can_edit_dataset(v_binding.dataset_id) then
    raise exception 'binding_claim_run: dataset is not writable by the caller';
  end if;
  if v_run.claim is not null
    and v_run.last_progress_at > now() - public.binding_stale_run_interval() then
    return null;
  end if;
  if v_run.status = 'collecting' then
    if coalesce(v_run.collect_attempts, 0) + 1 > public.binding_max_collect_attempts() then
      update public.sync_runs
        set status = 'failed', finished_at = now(),
            error = 'Collect was scheduled ' || coalesce(v_run.collect_attempts, 0)::text
                    || ' times without completing; giving up on this run.'
        where id = p_run_id;
      return null;
    end if;
    v_claim := replace(gen_random_uuid()::text, '-', '');
    update public.sync_runs
      set claim = v_claim,
          collect_attempts = coalesce(v_run.collect_attempts, 0) + 1,
          last_progress_at = now()
      where id = p_run_id;
    return v_claim;
  end if;
  v_claim := replace(gen_random_uuid()::text, '-', '');
  update public.sync_runs
    set claim = v_claim, last_progress_at = now()
    where id = p_run_id;
  return v_claim;
end $$;

-- Marks the collect leg done (sync.ts's markCollected): the client drained
-- its source to exhaustion and uploaded the chunk blobs; the run flips to
-- applying and carries the blobs' paths + the drained cursor. False = the
-- lease was lost — the caller schedules nothing (#127 defect 7).
create function public.binding_mark_collected(
  p_run_id          uuid,
  p_claim           text,
  p_chunk_paths     text[],
  p_total           integer,
  p_last_commit_id  text   default null,
  p_last_seq        bigint default null,
  p_remote_revision bigint default null
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run public.sync_runs;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status <> 'collecting'
    or v_run.claim is distinct from p_claim then
    return false;
  end if;
  update public.sync_runs
    set chunk_paths = p_chunk_paths,
        chunk_index = 0,
        row_offset = 0,
        status = 'applying',
        total = p_total,
        last_commit_id = p_last_commit_id,
        last_seq = p_last_seq,
        remote_revision = coalesce(p_remote_revision, remote_revision),
        last_progress_at = now()
    where id = p_run_id;
  return true;
end $$;

-- Applies one batch of source rows, keyed and idempotently (sync.ts's
-- applyRowsBatch). The checkpoint lands in the same transaction as the
-- writes, so a crash resumes without duplicating or skipping a row.
-- p_rows: [{key, data, geometry?}]. Returns the run's state.
create function public.binding_apply_rows_batch(
  p_run_id      uuid,
  p_claim       text,
  p_chunk_index integer,
  p_row_offset  integer,
  p_rows        jsonb     -- [{key, data, geometry?}]
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run     public.sync_runs;
  v_binding public.dataset_bindings;
  v_tally   jsonb;
  v_row     jsonb;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status <> 'applying'
    or v_run.claim is distinct from p_claim then
    raise exception 'binding_apply_rows_batch: the run is not applying under this claim';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'binding_apply_rows_batch: p_rows must be an array of {key, data, geometry?}';
  end if;
  select * into v_binding from public.dataset_bindings where id = v_run.binding_id;

  v_tally := jsonb_build_object(
    'added', 0, 'updated', 0, 'removed', 0,
    'needsReconcile', coalesce(v_run.needs_reconcile, false),
    'ops', v_run.ops, 'truncated', v_run.truncated);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row -> 'data') is distinct from 'object'
      or coalesce(v_row ->> 'key', '') = '' then
      raise exception 'binding_apply_rows_batch: every row needs a key and an object data';
    end if;
    v_tally := public.binding_apply_row(v_binding, p_run_id, v_tally, v_row);
  end loop;

  perform public.binding_patch_run_batch(p_run_id, v_tally,
    jsonb_array_length(p_rows), p_chunk_index, p_row_offset);
  return public.binding_run_state(p_run_id);
end $$;

-- Applies one batch of commit-feed entries — the design's PRIMARY sync path
-- (§5; sync.ts's applyCommitsBatch). Each commit's ops apply by key through
-- the map; every applied commit mirrors into commit_mirror — idempotent on
-- (binding_id, foreign_commit_id), so a replayed tail never duplicates
-- History rows (#127 defect 8). p_commits: [{foreignCommitId, seq, message,
-- at, ops: [{entryKey, op, fields, geometryChanged}]}].
create function public.binding_apply_commits_batch(
  p_run_id      uuid,
  p_claim       text,
  p_chunk_index integer,
  p_row_offset  integer,
  p_commits     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run     public.sync_runs;
  v_binding public.dataset_bindings;
  v_tally   jsonb;
  v_commit  jsonb;
  v_op      jsonb;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status <> 'applying'
    or v_run.claim is distinct from p_claim then
    raise exception 'binding_apply_commits_batch: the run is not applying under this claim';
  end if;
  if p_commits is null or jsonb_typeof(p_commits) is distinct from 'array' then
    raise exception 'binding_apply_commits_batch: p_commits must be an array of commit entries';
  end if;
  select * into v_binding from public.dataset_bindings where id = v_run.binding_id;

  v_tally := jsonb_build_object(
    'added', 0, 'updated', 0, 'removed', 0,
    'needsReconcile', coalesce(v_run.needs_reconcile, false),
    'ops', v_run.ops, 'truncated', v_run.truncated);

  for v_commit in select * from jsonb_array_elements(p_commits)
  loop
    if coalesce(v_commit ->> 'foreignCommitId', '') = ''
      or v_commit ->> 'seq' is null then
      raise exception 'binding_apply_commits_batch: every commit needs foreignCommitId and seq';
    end if;
    for v_op in select * from jsonb_array_elements(coalesce(v_commit -> 'ops', '[]'::jsonb))
    loop
      v_op := v_op || jsonb_build_object('commitSeq', v_commit -> 'seq');
      v_tally := public.binding_apply_commit_op(v_binding, p_run_id, v_tally, v_op);
    end loop;
    -- The mirror (the History rail's + commit overlays' data, kept host-side
    -- so the foreign app can prune its own log).
    insert into public.commit_mirror
      (binding_id, foreign_commit_id, seq, message, ops, at)
    values (
      v_run.binding_id,
      v_commit ->> 'foreignCommitId',
      (v_commit ->> 'seq')::bigint,
      coalesce(v_commit ->> 'message', ''),
      coalesce(v_commit -> 'ops', '[]'::jsonb),
      case when v_commit ->> 'at' is not null
        then to_timestamp(((v_commit ->> 'at')::bigint) / 1000.0)
        else now() end)
    on conflict (binding_id, foreign_commit_id) do nothing;
  end loop;

  perform public.binding_patch_run_batch(p_run_id, v_tally,
    jsonb_array_length(p_commits), p_chunk_index, p_row_offset);
  return public.binding_run_state(p_run_id);
end $$;

-- Stamps the binding + writes the activity row + prunes the mirror, then
-- completes the run (sync.ts's completeRun). Full modes complete from their
-- last sweep batch (binding_sweep_batch calls this when a short batch ends
-- the sweep); a tail run completes at finalize.
create function public.binding_complete_run(p_run_id uuid) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run         public.sync_runs;
  v_binding     public.dataset_bindings;
  v_entry_count integer;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status not in ('applying', 'sweeping') then
    return;
  end if;
  select * into v_binding from public.dataset_bindings where id = v_run.binding_id;

  select coalesce(entry_count, 0) into v_entry_count
    from public.datasets where id = v_binding.dataset_id;

  update public.dataset_bindings
    set last_applied_commit_id  = v_run.last_commit_id,
        last_applied_commit_seq = v_run.last_seq,
        last_reconciled_at      = case when v_run.mode = 'reconcile'
          then now() else last_reconciled_at end,
        last_synced_at          = now(),
        remote_revision         = coalesce(v_run.remote_revision, remote_revision),
        synced_entry_count      = v_entry_count
    where id = v_binding.id;

  insert into public.dataset_activity
    (binding_id, kind, added, updated, removed, entry_count, ops,
     needs_reconcile, synced_at, truncated)
  values (
    v_binding.id,
    case when v_run.mode = 'reconcile' then 'reconcile' else 'sync' end,
    v_run.added, v_run.updated, v_run.removed, v_entry_count,
    v_run.ops, v_run.needs_reconcile, now(), v_run.truncated);

  update public.sync_runs
    set status = 'completed', finished_at = now()
    where id = p_run_id;

  -- The commit mirror stays bounded: the newest COMMIT_MIRROR_LIMIT rows per
  -- binding survive; the foreign feed remains the durable record.
  delete from public.commit_mirror m
  using (
    select id, row_number() over (order by seq desc) as rn
    from public.commit_mirror
    where binding_id = v_binding.id
  ) ranked
  where m.id = ranked.id and ranked.rn > public.binding_commit_mirror_limit();

  -- Version retention rides the stage-4 machinery: the binding's keep-N/pin
  -- knobs mirror into the chain's policy row, then the same enforcement
  -- publish_version runs retires past-keep versions (pins exempt). The run's
  -- driver passed can_edit_dataset at start/claim, so the retention call's
  -- owner-or-editor gate holds.
  if v_binding.keep_versions is not null or v_binding.pinned_refs <> '{}' then
    insert into public.version_policies (dataset_key, keep_versions, pinned_refs)
    values (v_binding.dataset_id::text, v_binding.keep_versions, v_binding.pinned_refs)
    on conflict (dataset_key) do update
      set keep_versions = excluded.keep_versions,
          pinned_refs = excluded.pinned_refs;
    perform public.enforce_version_retention(v_binding.dataset_id);
  end if;
end $$;

-- Finalizes the apply phase (sync.ts's finalizeRun): a tail run carried its
-- deletes explicitly — complete now; full modes hand to the batched sweep.
create function public.binding_finalize_run(p_run_id uuid, p_claim text) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run public.sync_runs;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status <> 'applying'
    or v_run.claim is distinct from p_claim then
    return;
  end if;
  if v_run.mode = 'commit-tail' then
    perform public.binding_complete_run(p_run_id);
    return;
  end if;
  update public.sync_runs
    set status = 'sweeping', last_progress_at = now()
    where id = p_run_id;
end $$;

-- One bounded batch of the finalize sweep (sync.ts's sweepStaleBatch):
-- retires up to SWEEP_BATCH stale mappings — keys the run never saw, i.e.
-- source deletes — and, when the batch comes back short (the sweep is
-- clean), completes the run. The client loops until a short batch; the
-- completion happens inside that final call.
create function public.binding_sweep_batch(p_run_id uuid) returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run     public.sync_runs;
  v_binding public.dataset_bindings;
  v_tally   jsonb;
  v_stale   record;
  v_batch   integer := 0;
  v_max     integer := public.binding_sweep_batch_size();
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status <> 'sweeping' then
    return 0;
  end if;
  select * into v_binding from public.dataset_bindings where id = v_run.binding_id;

  v_tally := jsonb_build_object(
    'added', 0, 'updated', 0, 'removed', 0,
    'needsReconcile', coalesce(v_run.needs_reconcile, false),
    'ops', v_run.ops, 'truncated', v_run.truncated);

  for v_stale in
    select be.id, be.entry_id, be.entry_key
    from public.binding_entries be
    where be.binding_id = v_run.binding_id
      and be.seen_run is distinct from p_run_id::text
    limit v_max
  loop
    delete from public.entries where id = v_stale.entry_id;
    delete from public.binding_entries where id = v_stale.id;
    v_batch := v_batch + 1;
    v_tally := public.binding_record_op(v_tally, v_stale.entry_key, 'remove');
  end loop;
  v_tally := public.binding_tally_bump(v_tally, 'removed', v_batch);

  perform public.binding_patch_run_batch(p_run_id, v_tally, 0, v_run.chunk_index, v_run.row_offset);

  if v_batch < v_max then
    -- The sweep is clean — completion stamps the activity row from the run
    -- row, which now includes THIS batch's removals.
    perform public.binding_complete_run(p_run_id);
  end if;
  return v_batch;
end $$;

-- Fails a run cleanly (sync.ts's markRunFailed): the error is recorded, the
-- run leaves the active set, and the chunk blob paths ride the row for the
-- client's best-effort cleanup.
create function public.binding_fail_run(p_run_id uuid, p_claim text, p_error text) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run public.sync_runs;
begin
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status in ('completed', 'failed')
    or (v_run.claim is not null and v_run.claim is distinct from p_claim) then
    return;
  end if;
  update public.sync_runs
    set status = 'failed', error = p_error, finished_at = now()
    where id = p_run_id;
end $$;

-- The weekly reconcile scheduler (the cron's body): one `reconcile` run row
-- per binding that has no active run. These are WORK ITEMS — the resumable
-- client half (store/bindings.ts) claims and drains them; see the pg_cron
-- note in the file header.
create function public.binding_schedule_reconciles() returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_binding record;
  v_count   integer := 0;
  v_active  integer;
begin
  for v_binding in select id from public.dataset_bindings
  loop
    select count(*) into v_active from public.sync_runs
      where binding_id = v_binding.id
        and status in ('collecting', 'applying', 'sweeping');
    if v_active = 0 then
      insert into public.sync_runs (binding_id, mode, status, claim, collect_attempts)
      values (v_binding.id, 'reconcile', 'collecting', null, 0);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- The explicit exit path (the #75 bindings.unbind parity): unbinding deletes
-- the projection — the bound dataset, whose cascade takes the binding and,
-- with it, every binding_entries / sync_runs / commit_mirror /
-- dataset_activity row — while the source is untouched; re-binding
-- re-creates the dataset. Creator-only (restoring editability is the
-- creator's call).
create function public.binding_unbind(p_binding_id uuid) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_binding public.dataset_bindings;
  v_dataset public.datasets;
begin
  select * into v_binding from public.dataset_bindings where id = p_binding_id;
  if v_binding.id is null then
    return;
  end if;
  select * into v_dataset from public.datasets where id = v_binding.dataset_id;
  if v_dataset.id is not null and v_dataset.created_by is distinct from auth.uid() then
    raise exception 'binding_unbind: only the dataset''s creator can unbind it';
  end if;
  delete from public.datasets where id = v_binding.dataset_id;
end $$;

-- Records one manifest check (remoteSources.check parity): checked_at on
-- every check; a failed check records its error and KEEPS the last
-- successful layer read. Authenticated (the client fetched the manifest).
create function public.remote_source_check(
  p_source              text,
  p_ok                  boolean,
  p_error               text    default null,
  p_layer               jsonb   default null,
  p_record_url_template text    default null
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.remote_sources
    (source, checked_at, error, layer, record_url_template)
  values (p_source, now(), case when p_ok then null else p_error end,
          case when p_ok then p_layer else null end, p_record_url_template)
  on conflict (source) do update
    set checked_at = now(),
        error = case when p_ok then null else coalesce(p_error, remote_sources.error) end,
        layer = case when p_ok then p_layer else remote_sources.layer end,
        record_url_template = coalesce(p_record_url_template, remote_sources.record_url_template);
end $$;

-- ---------------------------------------------------------------------------
-- 0009-limitation hardening (parity list item 5, decision in the header):
-- publish_version refuses a storage-backed oversized geometry. Re-emitted
-- verbatim from 0011 — every gate, the lineage stamp, the idempotency point,
-- the materialization, the keep-N hook, and the stage-6 dataset-scoped
-- lookups are untouched; the ONLY delta is the guard below the write gate.
-- ---------------------------------------------------------------------------

create or replace function public.publish_version(
  p_dataset       uuid,
  p_version_label text,
  p_publish_key   text,     -- idempotency key
  p_lineage       jsonb default null
)
returns uuid               -- dataset_versions.id
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_lineage jsonb;
  v_oversized integer;
begin
  if p_dataset is null
     or p_version_label is null or btrim(p_version_label) = ''
     or p_publish_key is null or btrim(p_publish_key) = '' then
    raise exception 'publish_version requires a dataset, a non-empty version label, and a non-empty publish key';
  end if;

  -- §4's write gate, restated for the definer (0005 pattern): locked =
  -- creator only, frozen = nobody, open = any signed-in user. This is the
  -- "RLS answers before the RPC body runs" of §5.4, expressed where the
  -- definer can enforce it.
  if not public.can_edit_dataset(p_dataset) then
    raise exception 'publish_version: dataset is not writable by the caller';
  end if;

  -- 0012 (stage-7 parity list): storage-backed oversized geometries (> 256
  -- KB, source_path set, source null) cannot be frozen — the materialization
  -- below reads no Storage (0009's recorded limitation). Refuse LOUDLY here:
  -- a frozen chain that quietly lost those rows' geometry is worse than a
  -- refused freeze, and refusing at publish means stage-5 consumers can
  -- never open a half-frozen chain. The cron-backfill alternative was
  -- rejected as impossible in this stack (Storage bytes live in the
  -- storage-api's volume; storage.objects is metadata — no SQL path reads
  -- them; see the migration header).
  select count(*) into v_oversized
  from public.geometries g
  where g.dataset_id = p_dataset
    and g.source is null and g.source_path is not null;
  if v_oversized > 0 then
    raise exception
      'publish_version: % row(s) carry storage-backed oversized geometry that cannot be frozen into a version (0009 limitation — Storage payloads are unreadable from SQL). Simplify or re-import those rows, or publish without them.',
      v_oversized;
  end if;

  -- "A ref never freezes twice" — scoped to the CALLER'S chain (the stage-6
  -- parity patch; 0009 answered the global lookup): the same dataset's
  -- refrozen ref answers its existing version id (the freeze
  -- short-circuit), while a FOREIGN chain's colliding ref falls through to
  -- the INSERT below — where the publish_key conflict (publish_key = ref by
  -- construction) and the scoped race re-select answer NULL, never another
  -- dataset's row.
  select id into v_id from public.dataset_versions
    where ref = p_publish_key and dataset_id = p_dataset;
  if v_id is not null then
    return v_id;
  end if;

  -- The lineageValidator shape (component schema.ts:33-49), camelCase keys
  -- in the jsonb. A plain publish fills the narrow draft shape
  -- (publish.ts:717-727: frozenAt + snapshotRef + versionLabel — the source
  -- dataset rides the dataset_id column, which is the PG chain anchor);
  -- a caller-supplied p_lineage (stage 5's derived publishes carry recipe +
  -- sourceVersions) is kept and overlaid with the freeze-time facts.
  v_lineage := coalesce(p_lineage, '{}'::jsonb) || jsonb_build_object(
    'frozenAt',    (extract(epoch from now()) * 1000)::bigint,
    'snapshotRef', p_publish_key,
    'versionLabel', btrim(p_version_label)
  );

  -- The idempotency point (§5.4): ON CONFLICT (publish_key) DO NOTHING +
  -- re-select — a retried/killed publish cannot fork two v1s.
  insert into public.dataset_versions
    (dataset_id, ref, publish_key, version_label, lineage, created_by)
  values
    (p_dataset, p_publish_key, p_publish_key, btrim(p_version_label), v_lineage, auth.uid())
  on conflict (publish_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost the idempotency race to the concurrent winner: return ITS row —
    -- scoped to this chain like the by-ref lookup above (publish_key = ref
    -- by construction, so a GLOBAL re-select would re-introduce exactly the
    -- cross-chain answer the scoped lookup just removed). A miss means the
    -- key is held by a FOREIGN chain: return null — the caller's "no
    -- version id" error — never someone else's row.
    select id into v_id from public.dataset_versions
      where publish_key = p_publish_key and dataset_id = p_dataset;
    return v_id;
  end if;

  -- The materialization (§5.4): set-based INSERT..SELECT over the live
  -- entries left joined to their inline geometry, frozen verbatim.
  -- entry_id is provenance only — the jsonb row is the truth. `ordinal` is
  -- the dataset's stable read order (created_at, id — the
  -- entries_dataset_created index), so paged frozen reads are keyset-stable.
  -- (0009's KNOWN LIMITATION on storage-backed rows is UNREACHABLE since the
  -- 0012 guard above: this select can no longer see a source-less geometry.)
  insert into public.version_entries
    (version_id, entry_id, data, geometry, geometry_type, bbox, ordinal)
  select
    v_id,
    e.id,
    e.data,
    g.source,
    coalesce(g.type, e.geometry_type),
    g.bbox,
    row_number() over (order by e.created_at, e.id)
  from public.entries e
  left join public.geometries g on g.entry_id = e.id
  where e.dataset_id = p_dataset;

  -- The keep-N hook (the afterPublishCompleted pattern —
  -- consumption.ts:470 runs retention "after every publish completion so
  -- publish chains stay bounded"), same transaction as the freeze.
  perform public.enforce_version_retention(p_dataset);

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- EXECUTE grants (the default PUBLIC grant would hand anon the RPC surface;
-- the cron's caller is the superuser, which execute revokes never bind).
-- ---------------------------------------------------------------------------

revoke all on function
  public.binding_ensure(text, jsonb, jsonb),
  public.binding_start_run(text, text),
  public.binding_claim_run(uuid),
  public.binding_mark_collected(uuid, text, text[], integer, text, bigint, bigint),
  public.binding_apply_rows_batch(uuid, text, integer, integer, jsonb),
  public.binding_apply_commits_batch(uuid, text, integer, integer, jsonb),
  public.binding_finalize_run(uuid, text),
  public.binding_sweep_batch(uuid),
  public.binding_fail_run(uuid, text, text),
  public.binding_schedule_reconciles(),
  public.binding_unbind(uuid),
  public.remote_source_check(text, boolean, text, jsonb, text),
  public.binding_run_state(uuid)
  from public, anon;

grant execute on function
  public.binding_ensure(text, jsonb, jsonb),
  public.binding_start_run(text, text),
  public.binding_claim_run(uuid),
  public.binding_mark_collected(uuid, text, text[], integer, text, bigint, bigint),
  public.binding_apply_rows_batch(uuid, text, integer, integer, jsonb),
  public.binding_apply_commits_batch(uuid, text, integer, integer, jsonb),
  public.binding_finalize_run(uuid, text),
  public.binding_sweep_batch(uuid),
  public.binding_fail_run(uuid, text, text),
  public.binding_unbind(uuid),
  public.remote_source_check(text, boolean, text, jsonb, text),
  public.binding_run_state(uuid)
  to authenticated;

-- The scheduler is the cron's alone: no interactive principal needs it.
revoke all on function public.binding_schedule_reconciles() from authenticated;
grant execute on function public.binding_schedule_reconciles() to service_role;

-- ---------------------------------------------------------------------------
-- pg_cron — the weekly reconcile (§16's placement decision: same instance).
-- Mondays 09:00 UTC (the Convex crons.ts cadence). Unschedule-first keeps the
-- file re-runnable; the extension ships in this image's shared_preload list.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

do $do$
begin
  begin
    perform cron.unschedule('weekly-bindings-reconcile');
  exception when undefined_object or others then
    -- First apply (no such job yet).
    null;
  end;
  perform cron.schedule(
    'weekly-bindings-reconcile',
    '0 9 * * 1',
    $job$ select public.binding_schedule_reconciles() $job$);
exception
  when others then
    raise notice '0012: pg_cron unavailable in this environment — the weekly reconcile job was not registered (%)', sqlerrm;
end
$do$;

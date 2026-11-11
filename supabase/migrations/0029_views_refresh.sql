-- Views refresh modes: `auto` and `live` (issue #305; docs/views-design.md §7,
-- ADR 0028 §3).
--
--   §1  datasets.auto_refresh_by — the identity an `auto` run executes as.
--   §2  view_refresh_queue — the debounce/job table. A statement-level
--       data_version bump on an input enqueues every unpinned `auto` view
--       reading it; the app server drains the queue (the run needs the TS
--       compiler, so pg_cron — which exists in the stack — could only call
--       something, not run the view).
--   §3  set_view_refresh_mode — the ONLY way to move a view to auto/live
--       (runner-only, so the server's spatial-step refusal for `live` cannot
--       be bypassed through PostgREST); create_view / save_view are tightened
--       to refuse auto/live.
--   §4  drain helpers: view_refresh_claim / view_refresh_finish /
--       view_refresh_record_failure (runner-only definers; none execute user
--       SQL, the run itself still goes through the two-phase runner).
--   §5  view_sync_live_meta — a live view saves no rows but still needs its
--       declared columns / geometry flag, so an editor's live read mirrors
--       them (metadata only).
--   §6  view_stale is never true for a live view (nothing is saved to be
--       stale).

-- ---------------------------------------------------------------------------
-- §1 — identity of auto runs
-- ---------------------------------------------------------------------------

alter table public.datasets
  add column auto_refresh_by uuid references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------------
-- §2 — the queue
-- ---------------------------------------------------------------------------

-- One row per view with a pending or running auto refresh.
--   due_at      when the run becomes claimable (first change + the window).
--   claimed_at  set while a worker runs it (the "at most one concurrent run
--               per view" lock; a claim older than 15 min is abandoned).
--   redo_at     a change that arrived WHILE the run was in flight; the finish
--               step re-queues it instead of dropping it.
create table public.view_refresh_queue (
  view_id    uuid primary key references public.datasets on delete cascade,
  queued_at  timestamptz not null default now(),
  due_at     timestamptz not null,
  claimed_at timestamptz,
  redo_at    timestamptz
);
create index view_refresh_queue_due on public.view_refresh_queue (due_at);

revoke all on public.view_refresh_queue from anon, authenticated, service_role;
alter table public.view_refresh_queue enable row level security;
-- The header's "next refresh queued" reads it (editors and the creator).
grant select on public.view_refresh_queue to authenticated;
create policy "view_refresh_queue select: editors and the creator"
  on public.view_refresh_queue for select to authenticated
  using (public.view_run_readable(view_id));

-- The coalescing window. A change opens a window of this many seconds; every
-- further change inside it joins the same run. Overridable per database
-- (`alter database … set jdm.view_refresh_debounce_seconds = 5`).
create function public.view_refresh_debounce() returns interval
language sql stable set search_path = public as $$
  select make_interval(secs => coalesce(
    nullif(current_setting('jdm.view_refresh_debounce_seconds', true), '')::double precision, 60));
$$;

-- Enqueue (or coalesce) one auto view. A pending row keeps its due_at (so a
-- continuous stream of edits cannot starve the refresh); a row that is
-- already running remembers the change in redo_at.
create function public.view_refresh_enqueue(p_view uuid, p_immediate boolean default false)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_due timestamptz := case when p_immediate then now() else now() + public.view_refresh_debounce() end;
begin
  insert into public.view_refresh_queue as q (view_id, due_at)
  values (p_view, v_due)
  on conflict (view_id) do update
    set redo_at = case when q.claimed_at is not null then v_due else q.redo_at end,
        due_at  = case when q.claimed_at is null and p_immediate then least(q.due_at, v_due) else q.due_at end;
end $$;

create function public.datasets_enqueue_auto_views() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_view uuid;
begin
  for v_view in
    select vi.view_id
    from public.view_inputs vi
    join public.datasets v on v.id = vi.view_id
    where vi.input_dataset_id = new.id
      and vi.pinned_version is null
      and v.kind = 'view'
      and v.refresh_mode = 'auto'
      and v.auto_refresh_by is not null
  loop
    perform public.view_refresh_enqueue(v_view);
  end loop;
  return null;
end $$;

create trigger datasets_data_version_enqueue
after update of data_version on public.datasets
for each row when (new.data_version is distinct from old.data_version)
execute function public.datasets_enqueue_auto_views();

-- ---------------------------------------------------------------------------
-- §3 — switching modes
-- ---------------------------------------------------------------------------

-- Called by the server (verified claims installed) after it has refused live
-- for spatial views. `auto` records who enabled it: that user is the identity
-- of every automatic run (design §7).
create function public.set_view_refresh_mode(p_view uuid, p_mode text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.datasets d where d.id = p_view and d.kind = 'view') then
    raise exception 'dataset % is not a view', p_view using errcode = 'P0002';
  end if;
  if not public.can_edit_dataset(p_view) then
    raise exception 'view % is not writable by the caller', p_view using errcode = '42501';
  end if;
  if p_mode not in ('manual', 'auto', 'live') then
    raise exception 'unknown refresh mode %', p_mode;
  end if;
  update public.datasets
  set refresh_mode = p_mode,
      auto_refresh_by = case when p_mode = 'auto' then auth.uid() end
  where id = p_view;
  if p_mode = 'auto' then
    -- Catch up straight away when the saved rows are behind.
    if (select d2.stale from (select public.view_stale(d) as stale from public.datasets d where d.id = p_view) d2) then
      perform public.view_refresh_enqueue(p_view, true);
    end if;
  else
    delete from public.view_refresh_queue where view_id = p_view;
  end if;
end $$;

-- create_view / save_view may no longer move a view to auto/live: only
-- set_view_refresh_mode (runner-only) may.
create or replace function public.create_view(
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
  if coalesce(p_refresh_mode, 'manual') <> 'manual' then
    raise exception 'a view is created in manual mode; switch it to % afterwards', p_refresh_mode
      using errcode = '42501';
  end if;
  insert into public.datasets
    (title, description, kind, definition, refresh_mode, output_settings,
     lifecycle, visibility, edit_policy, created_by)
  values
    (p_title, p_description, 'view', p_definition, 'manual',
     p_output_settings, p_lifecycle, p_visibility, p_edit_policy, auth.uid())
  returning id into v_id;
  perform public.view_set_inputs(v_id, p_inputs);
  return v_id;
end $$;

create or replace function public.save_view(
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
declare
  v_mode text;
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
  select d.refresh_mode into v_mode from public.datasets d where d.id = p_view;
  if p_refresh_mode is not null and p_refresh_mode is distinct from v_mode
     and p_refresh_mode <> 'manual' then
    raise exception 'use set_view_refresh_mode to move a view to %', p_refresh_mode
      using errcode = '42501';
  end if;
  perform public.view_set_inputs(p_view, p_inputs);
  update public.datasets
  set definition = p_definition,
      refresh_mode = coalesce(p_refresh_mode, refresh_mode),
      auto_refresh_by = case when coalesce(p_refresh_mode, refresh_mode) = 'auto' then auto_refresh_by end,
      output_settings = coalesce(p_output_settings, output_settings)
  where id = p_view;
  if coalesce(p_refresh_mode, v_mode) <> 'auto' then
    delete from public.view_refresh_queue where view_id = p_view;
  else
    -- A changed definition makes the saved rows stale: refresh them.
    perform public.view_refresh_enqueue(p_view);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §4 — the drain
-- ---------------------------------------------------------------------------

-- Claims up to p_limit due, unclaimed (or abandoned) refreshes, FOR UPDATE
-- SKIP LOCKED so several app servers can drain safely. Views that stopped
-- being auto are dropped from the queue here.
create function public.view_refresh_claim(p_limit integer default 5)
returns table (view_id uuid, run_as uuid)
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.view_refresh_queue q
  where not exists (
    select 1 from public.datasets d
    where d.id = q.view_id and d.kind = 'view' and d.refresh_mode = 'auto'
      and d.auto_refresh_by is not null);
  return query
  with due as (
    select q.view_id
    from public.view_refresh_queue q
    where q.due_at <= now()
      and (q.claimed_at is null or q.claimed_at < now() - interval '15 minutes')
    order by q.due_at
    limit greatest(p_limit, 1)
    for update skip locked
  ), claimed as (
    update public.view_refresh_queue q
    set claimed_at = now(), redo_at = null
    from due where q.view_id = due.view_id
    returning q.view_id
  )
  select c.view_id, d.auto_refresh_by
  from claimed c join public.datasets d on d.id = c.view_id;
end $$;

-- A claimed refresh ended (ok or error). A change that arrived mid-run
-- re-queues; otherwise the row goes away.
create function public.view_refresh_finish(p_view uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.view_refresh_queue q
  set claimed_at = null, due_at = q.redo_at, redo_at = null
  where q.view_id = p_view and q.redo_at is not null;
  delete from public.view_refresh_queue q
  where q.view_id = p_view and q.redo_at is null and q.claimed_at is not null;
end $$;

-- An errored auto run that the normal failure path cannot record (the
-- identity lost edit access, so view_record_failure refuses it). Records the
-- error against the view with the identity as created_by when the profile
-- still exists. Rows are untouched.
create function public.view_refresh_record_failure(
  p_view uuid, p_error text, p_started_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_run uuid;
begin
  insert into public.view_runs
    (view_id, status, started_at, input_versions, definition_hash, error, created_by)
  select d.id, 'error', coalesce(p_started_at, now()), '{}'::jsonb, md5(d.definition::text),
         left(coalesce(p_error, 'unknown error'), 4000), d.auto_refresh_by
  from public.datasets d where d.id = p_view and d.kind = 'view'
  returning id into v_run;
  perform public.view_prune_runs(p_view);
  return v_run;
end $$;

-- ---------------------------------------------------------------------------
-- §5 — live views mirror their declared shape
-- ---------------------------------------------------------------------------

-- A live view stores no rows, but the table needs its columns and the map
-- needs to know it is geospatial. An editor's live read reports them here.
-- Idempotent (writes only on change) and a silent no-op for a non-editor.
create function public.view_sync_live_meta(p_view uuid, p_properties jsonb, p_geometry_types text[])
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.datasets d
                    where d.id = p_view and d.kind = 'view' and d.refresh_mode = 'live')
     or not public.can_edit_dataset(p_view) then
    return;
  end if;
  update public.datasets d
  set properties = p_properties,
      is_geospatial = coalesce(cardinality(p_geometry_types), 0) > 0,
      geometry_type = case when cardinality(p_geometry_types) = 1 then p_geometry_types[1] end
  where d.id = p_view
    and (d.properties, d.is_geospatial, d.geometry_type) is distinct from
        (p_properties, coalesce(cardinality(p_geometry_types), 0) > 0,
         case when cardinality(p_geometry_types) = 1 then p_geometry_types[1] end);
end $$;

-- ---------------------------------------------------------------------------
-- §6 — staleness of a live view
-- ---------------------------------------------------------------------------

create or replace function public.view_stale(d public.datasets) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select case when d.kind <> 'view' or d.refresh_mode = 'live' then false else (
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
-- Grants. Everything here is runner-only except the table read above.
-- ---------------------------------------------------------------------------

revoke all on function public.view_refresh_debounce() from anon, authenticated, service_role, public;
revoke all on function public.view_refresh_enqueue(uuid, boolean) from anon, authenticated, service_role, public;
revoke all on function public.datasets_enqueue_auto_views() from anon, authenticated, service_role, public;
revoke all on function public.set_view_refresh_mode(uuid, text) from anon, authenticated, service_role, public;
revoke all on function public.view_refresh_claim(integer) from anon, authenticated, service_role, public;
revoke all on function public.view_refresh_finish(uuid) from anon, authenticated, service_role, public;
revoke all on function public.view_refresh_record_failure(uuid, text, timestamptz) from anon, authenticated, service_role, public;
revoke all on function public.view_sync_live_meta(uuid, jsonb, text[]) from anon, authenticated, service_role, public;

grant execute on function public.set_view_refresh_mode(uuid, text) to view_runner;
grant execute on function public.view_refresh_claim(integer) to view_runner;
grant execute on function public.view_refresh_finish(uuid) to view_runner;
grant execute on function public.view_refresh_record_failure(uuid, text, timestamptz) to view_runner;
grant execute on function public.view_sync_live_meta(uuid, jsonb, text[]) to view_runner;
-- create_or_replace kept the 0027 grants; view_stale likewise.

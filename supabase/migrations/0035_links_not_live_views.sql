-- 0035: a dataset link (dataset_relations) end must have saved rows.
--
-- Relations are surfaced to users as "links" (map-click highlight + popup
-- list). Views may be link ends (a view is a dataset), but a LIVE view saves
-- no rows, so the bounded runtime query would see an empty side. Refuse the
-- combination in both directions: linking a live view, and switching a
-- linked view to live.

create or replace function public.dataset_relations_refuse_live_end()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.datasets d
    where d.id in (new.from_dataset, new.to_dataset)
      and d.kind = 'view' and d.refresh_mode = 'live'
  ) then
    raise exception 'A live view saves no rows, so it cannot be a link end. Use manual or auto refresh.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger dataset_relations_refuse_live_end
  before insert or update of from_dataset, to_dataset on public.dataset_relations
  for each row execute function public.dataset_relations_refuse_live_end();

create or replace function public.datasets_refuse_live_when_linked()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'view' and new.refresh_mode = 'live'
     and new.refresh_mode is distinct from old.refresh_mode
     and exists (
       select 1 from public.dataset_relations r
       where r.from_dataset = new.id or r.to_dataset = new.id
     ) then
    raise exception 'This view has links, and a live view saves no rows. Remove its links first.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger datasets_refuse_live_when_linked
  before update of refresh_mode on public.datasets
  for each row execute function public.datasets_refuse_live_when_linked();

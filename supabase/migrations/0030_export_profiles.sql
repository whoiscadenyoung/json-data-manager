-- 0030: export profiles (issue #303; docs/views-design.md §9–§10).
--
-- A profile is a named bundle of export settings on a dataset (in practice a
-- view): { format: geojson|csv|json, propertyNames: keys|labels,
-- emptyFields: keep|omit, precision: int|null }. Exporting always reads the
-- dataset's SAVED rows; the profile only describes how to write them.
--
-- Gates follow the dataset: anyone who can view the dataset reads its
-- profiles, anyone who can edit it manages them. Labels and hidden flags live
-- in the view definition's `output` (single source of truth), not here.

create table public.export_profiles (
  id         uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets on delete cascade,
  name       text not null check (btrim(name) <> ''),
  settings   jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (dataset_id, name)
);
create index export_profiles_by_dataset on public.export_profiles (dataset_id);

alter table public.export_profiles enable row level security;

revoke all on public.export_profiles from anon, authenticated, service_role;
grant select, insert, delete on public.export_profiles to authenticated;
grant update (name, settings) on public.export_profiles to authenticated;

create policy "export_profiles select: the dataset is viewable"
  on public.export_profiles for select to authenticated
  using (public.can_view_dataset(dataset_id));

create policy "export_profiles insert: dataset editors"
  on public.export_profiles for insert to authenticated
  with check (public.can_edit_dataset(dataset_id) and created_by = auth.uid());

create policy "export_profiles update: dataset editors"
  on public.export_profiles for update to authenticated
  using (public.can_edit_dataset(dataset_id))
  with check (public.can_edit_dataset(dataset_id));

create policy "export_profiles delete: dataset editors"
  on public.export_profiles for delete to authenticated
  using (public.can_edit_dataset(dataset_id));

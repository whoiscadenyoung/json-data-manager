-- ---------------------------------------------------------------------------
-- §6 — Storage buckets
--
-- The four private buckets the design names. Stage 1 uses `geometries`
-- (oversized geometry payloads, > 256 KB, written by the import flow before
-- its `import_entries` chunks) and `source-files` (retained original import
-- files); `tile-archives` and `marker-sprites` arrive with stage 2 but are
-- pure config rows, created here so each later stage flips to using them
-- without another storage migration.
--
-- All four are private: reads ride short-lived signed URLs (the store's
-- `createSignedUrl` calls). Authorization mirrors the data tables' RLS
-- instead of a blanket bucket grant: the dataset-shaped buckets key every
-- object's first path segment to the owning dataset
-- (`<datasetId>/...`, §3.2 — `geometries/<datasetId>/row-<n>.json`,
-- `source-files/<datasetId>/<file>`, the stage-2
-- `tile-archives/<datasetId>/...`), so reads issue signed URLs only for
-- `can_view_dataset` holders and writes/overwrites/deletes require
-- `can_edit_dataset` — the same gate the tables apply, which also keeps a
-- frozen (lineage not null) dataset's payloads read-only through Storage
-- (ADR 0009). A first segment that is not a dataset id parses to null and
-- every helper answers false: unknown shapes fail closed. `marker-sprites`
-- has no dataset linkage — until stage 2 defines sprite sharing, its objects
-- are uploader-owned (the storage service stamps owner/owner_id from the JWT).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values
  ('geometries', 'geometries', false),
  ('source-files', 'source-files', false),
  ('tile-archives', 'tile-archives', false),
  ('marker-sprites', 'marker-sprites', false)
on conflict (id) do nothing;

-- The dataset id a bucket object's path belongs to: the first path segment as
-- a uuid, or null when the shape doesn't match (fail closed).
create function public.dataset_id_of_storage_path(p_name text) returns uuid
language sql
stable
as $$
  select case
    when split_part(coalesce(p_name, ''), '/', 1)
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (split_part(coalesce(p_name, ''), '/', 1))::uuid
  end
$$;

-- One policy per statement kind on storage.objects. The supabase base image
-- ships storage.objects with no policies, so these are the only grants;
-- `drop policy if exists` keeps the file re-runnable the same way the bucket
-- inserts are.
drop policy if exists "migrated buckets: authenticated insert" on storage.objects;
drop policy if exists "migrated buckets: authenticated select" on storage.objects;
drop policy if exists "migrated buckets: authenticated update" on storage.objects;
drop policy if exists "migrated buckets: authenticated delete" on storage.objects;
drop policy if exists "migrated dataset buckets: insert requires can_edit_dataset" on storage.objects;
drop policy if exists "migrated dataset buckets: select requires can_view_dataset" on storage.objects;
drop policy if exists "migrated dataset buckets: update requires can_edit_dataset" on storage.objects;
drop policy if exists "migrated dataset buckets: delete requires can_edit_dataset" on storage.objects;
drop policy if exists "marker-sprites: uploader-owned" on storage.objects;

create policy "migrated dataset buckets: insert requires can_edit_dataset"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('geometries', 'source-files', 'tile-archives')
    and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
  );

create policy "migrated dataset buckets: select requires can_view_dataset"
  on storage.objects for select to authenticated
  using (
    bucket_id in ('geometries', 'source-files', 'tile-archives')
    and public.can_view_dataset(public.dataset_id_of_storage_path(name))
  );

create policy "migrated dataset buckets: update requires can_edit_dataset"
  on storage.objects for update to authenticated
  using (
    bucket_id in ('geometries', 'source-files', 'tile-archives')
    and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
  )
  with check (
    bucket_id in ('geometries', 'source-files', 'tile-archives')
    and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
  );

create policy "migrated dataset buckets: delete requires can_edit_dataset"
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('geometries', 'source-files', 'tile-archives')
    and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
  );

create policy "marker-sprites: uploader-owned"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'marker-sprites'
    and (owner = auth.uid() or owner_id = auth.uid()::text)
  )
  with check (
    bucket_id = 'marker-sprites'
    and (owner = auth.uid() or owner_id = auth.uid()::text)
  );

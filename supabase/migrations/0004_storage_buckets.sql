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
-- `createSignedUrl` calls). Uploads are browser-direct (`storage.upload`),
-- which RLS gates: any authenticated user may put objects (the trusted-
-- collaborator model, ADR 0009 — the same gate `can_edit_dataset` applies to
-- data writes; per-object ownership refinement is a stage-2+ concern).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values
  ('geometries', 'geometries', false),
  ('source-files', 'source-files', false),
  ('tile-archives', 'tile-archives', false),
  ('marker-sprites', 'marker-sprites', false)
on conflict (id) do nothing;

-- One policy per statement kind on storage.objects for these buckets. The
-- supabase base image ships storage.objects with no policies, so these are
-- the only grants; `drop policy if exists` keeps the file re-runnable the
-- same way the bucket inserts are.
drop policy if exists "migrated buckets: authenticated insert" on storage.objects;
drop policy if exists "migrated buckets: authenticated select" on storage.objects;
drop policy if exists "migrated buckets: authenticated update" on storage.objects;
drop policy if exists "migrated buckets: authenticated delete" on storage.objects;

create policy "migrated buckets: authenticated insert"
  on storage.objects for insert to authenticated
  with check (bucket_id in ('geometries', 'source-files', 'tile-archives', 'marker-sprites'));

create policy "migrated buckets: authenticated select"
  on storage.objects for select to authenticated
  using (bucket_id in ('geometries', 'source-files', 'tile-archives', 'marker-sprites'));

create policy "migrated buckets: authenticated update"
  on storage.objects for update to authenticated
  using (bucket_id in ('geometries', 'source-files', 'tile-archives', 'marker-sprites'))
  with check (bucket_id in ('geometries', 'source-files', 'tile-archives', 'marker-sprites'));

create policy "migrated buckets: authenticated delete"
  on storage.objects for delete to authenticated
  using (bucket_id in ('geometries', 'source-files', 'tile-archives', 'marker-sprites'));

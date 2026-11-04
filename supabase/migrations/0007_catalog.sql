-- Stage 3 — catalog (docs/supabase-migration-design.md §3.4's
-- collections/groups block + §3.2's deferred `datasets.group_id` column).
--
-- Stage 2 shipped the sketch's maps rows (0005); this file lands the rest of
-- the §3.4 catalog block the stage-3 acceptance (#202) needs:
--   collections / collection_datasets / groups
--   → packages/json-cms/src/component/schema.ts:54-68  (collections, groups)
--   → packages/json-cms/src/component/schema.ts:146-161 (schemaCollections join)
-- field-for-field, plus the datasets column the sketch marked
-- "added in stage 3" (§3.2 line "group_id uuid references public.groups on
-- delete set null" + its datasets_by_group index — 0003 deferred it because
-- public.groups did not exist yet).
--
-- §4 matrix rows for these three tables: every operation `authenticated`
-- (shared catalog artifacts — ADR 0009). The datasets-side writes that
-- catalog membership performs (the group assignment on datasets.group_id)
-- stay gated by datasets' own can_edit_dataset UPDATE policy (0003) —
-- regrouping a locked dataset is a locked-dataset write, exactly as the
-- component host's assertDatasetWritable treated it.
--
-- Deleted-with-parent cascades (§3.4 note) replace the component's explicit
-- deleteCollection/deleteGroup cleanup walks:
--   collection delete → memberships cascade (component walked by_collection);
--   group delete      → member datasets ungroup via ON DELETE SET NULL
--                       (component patched groupId: undefined);
--   collection delete → its groups FLOAT standalone via ON DELETE SET NULL
--                       (deviation from the component, whose deleteCollection
--                       DELETED nested groups — the binding DDL says set null,
--                       and a floating group is the schema's own standalone
--                       state; its datasets keep their group).
-- Map layers pointing at a deleted collection/group are NOT cleaned up here —
-- map_layers.target_id is deliberately FK-less text (0005, dangling-target
-- tolerance), and the stage-2 read paths already answer dangling targets
-- defensively. The component deleted such layers in its delete walks; PG
-- leaves the rows (inert, invisible in the workspace).

-- ---------------------------------------------------------------------------
-- §3.4 — collections
-- ---------------------------------------------------------------------------

create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_by  uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- §3.4 — collection_datasets (the many-to-many join)
-- ---------------------------------------------------------------------------

create table public.collection_datasets (
  collection_id uuid not null references public.collections on delete cascade,
  dataset_id    uuid not null references public.datasets on delete cascade,
  -- Denormalized from datasets (component parity — the membership row answers
  -- "geospatial?" with no dataset read, issue #54's collection-level N+1).
  -- Nullable per the sketch: the stamp trigger below fills it for every live
  -- row; NULL survives only where the dataset is RLS-invisible to the
  -- inserter (reads drop such members via the datasets embed anyway).
  kind          text check (kind in ('standard','geospatial')),
  primary key (collection_id, dataset_id)
);
-- The sketch's by_dataset reverse lookup (listCollectionsBySchema parity:
-- "which collections does this dataset belong to" without a scan). The PK's
-- btree serves the by_collection direction.
create index collection_datasets_by_dataset on public.collection_datasets (dataset_id);

-- ---------------------------------------------------------------------------
-- §3.4 — groups (join collections as single units — a group lives in at most
-- one collection, or floats standalone; never nests, schema.ts:59-68)
-- ---------------------------------------------------------------------------

create table public.groups (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid references public.collections on delete set null,
  name          text not null,
  description   text,
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index groups_by_collection on public.groups (collection_id);

-- ---------------------------------------------------------------------------
-- §3.2 — datasets.group_id (the sketch's "added in stage 3" column; 0003
-- deferred it because public.groups did not exist yet). A dataset belongs to
-- at most one group, independent of its collection memberships
-- (schema.ts:177-180). The FK's ON DELETE SET NULL is the component's
-- deleteGroup ungroup walk.
-- ---------------------------------------------------------------------------

alter table public.datasets
  add column group_id uuid references public.groups on delete set null;
create index datasets_by_group on public.datasets (group_id);
-- The column is client-writable through the setSchemaGroup membership op
-- (api.cms.collections.setSchemaGroup parity): 0003's UPDATE column grant
-- list predates the column (the sketch's stage-3 note covers the column AND
-- its grant). Without this grant every regroup would surface as a PostgREST
-- permission error, not the RLS-gated write the §4 matrix describes — the
-- can_edit_dataset UPDATE policy still gates WHO may regroup (locked =
-- creator-only); the grant only makes the column a "real field" like
-- title/edit_policy.
grant update (group_id) on public.datasets to authenticated;

-- ---------------------------------------------------------------------------
-- The `kind` denormalization, kept exact by triggers (the component stamped
-- it at membership insert and rewrote membership rows in
-- startGeospatialConversion when a dataset flipped kind — component
-- collections.ts:218-225 and the kind field's doc in schema.ts:148-157).
-- Doing it in the database makes the invariant hold for EVERY writer, not
-- just the store's.
-- ---------------------------------------------------------------------------

-- Stamp on membership write: kind is read off the dataset row at write time
-- (the addSchemaToCollection semantics), so the client cannot claim one.
-- SECURITY DEFINER like 0003's maintenance triggers: the writer may not be
-- able to SELECT the dataset row (RLS-invisible drafts), but the membership
-- row's kind must still be exact — invisible members drop out of reads
-- regardless.
create function public.collection_datasets_stamp_kind() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_geospatial boolean;
begin
  select is_geospatial into v_geospatial from public.datasets where id = new.dataset_id;
  if found then
    new.kind := case when v_geospatial then 'geospatial' else 'standard' end;
  end if;
  return new;
end $$;

create trigger collection_datasets_stamp_kind before insert or update
  on public.collection_datasets
  for each row execute function public.collection_datasets_stamp_kind();

-- Rewrite memberships when a dataset's kind flips (the
-- startGeospatialConversion walk). Row-level with a WHEN guard: the
-- stage-1-learned restriction (`update of <column>` lists are illegal for
-- transition-table triggers) does not bind row triggers, but the guard keeps
-- every unrelated dataset update from touching the join. Rewriting fires the
-- stamp trigger again per row — same value, idempotent.
create function public.collection_datasets_rewrite_kind() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.collection_datasets
    set kind = case when new.is_geospatial then 'geospatial' else 'standard' end
    where dataset_id = new.id;
  return null;
end $$;

create trigger datasets_rewrite_collection_kind after update
  on public.datasets
  for each row
  when (old.is_geospatial is distinct from new.is_geospatial)
  execute function public.collection_datasets_rewrite_kind();

-- ---------------------------------------------------------------------------
-- §3 conventions — attribution + updated_at maintenance (the 0003/0005
-- pattern: identity stamped from the request, never claimed from a payload;
-- the stamp runs BEFORE the RLS WITH CHECK so the checked row carries the
-- invoker's id).
-- ---------------------------------------------------------------------------

create trigger collections_stamp_created_by before insert on public.collections
  for each row execute function public.stamp_created_by();
create trigger groups_stamp_created_by before insert on public.groups
  for each row execute function public.stamp_created_by();

create trigger collections_set_updated_at before update on public.collections
  for each row execute function public.set_updated_at();
create trigger groups_set_updated_at before update on public.groups
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- §4 — RLS (the matrix's shared-catalog rows: collections, groups and
-- collection_datasets are authenticated read+write; anon gets nothing).
-- No dataset coupling on the join table — a membership to an RLS-invisible
-- dataset is inert (its reads drop it via the datasets embed; its kind reads
-- NULL), and dataset-side group assignments are gated by datasets' own
-- can_edit_dataset UPDATE policy.
-- ---------------------------------------------------------------------------

alter table public.collections       enable row level security;
alter table public.groups            enable row level security;
alter table public.collection_datasets enable row level security;

create policy "collections select: authenticated"
  on public.collections for select to authenticated using (true);
create policy "collections insert: authenticated"
  on public.collections for insert to authenticated with check (true);
create policy "collections update: authenticated"
  on public.collections for update to authenticated using (true) with check (true);
create policy "collections delete: authenticated"
  on public.collections for delete to authenticated using (true);

create policy "groups select: authenticated"
  on public.groups for select to authenticated using (true);
create policy "groups insert: authenticated"
  on public.groups for insert to authenticated with check (true);
create policy "groups update: authenticated"
  on public.groups for update to authenticated using (true) with check (true);
create policy "groups delete: authenticated"
  on public.groups for delete to authenticated using (true);

create policy "collection_datasets select: authenticated"
  on public.collection_datasets for select to authenticated using (true);
create policy "collection_datasets insert: authenticated"
  on public.collection_datasets for insert to authenticated with check (true);
create policy "collection_datasets update: authenticated"
  on public.collection_datasets for update to authenticated using (true) with check (true);
create policy "collection_datasets delete: authenticated"
  on public.collection_datasets for delete to authenticated using (true);

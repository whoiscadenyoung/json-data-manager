-- Stage 4 — versioning + publishing (docs/supabase-migration-design.md §3.5,
-- §5.4; GitHub issue #203). The versioning + publishing domain per the §3.5
-- sketch, field-for-field:
--   derived_datasets / dataset_versions / version_entries / tags /
--   consumer_references / version_policies / projects / project_artifacts /
--   publish_bundles / publish_bundle_members
-- plus the §5.4 `publish_version` RPC (set-based materialization), the §6
-- keep-N retention pass (`enforce_version_retention`, the afterPublish
-- pattern of app/convex/versions/consumption.ts:419), the #126
-- retire-pin-refusal guard trigger, and the §4 matrix's RLS rows.
--
-- Convex-era parity sources (READ-ONLY): app/convex/versions/{versioning,tags,
-- consumption,chain}.ts, app/convex/publishing/{publish,projects,bundles}.ts,
-- packages/json-cms/src/component/schema.ts (lineageValidator, :33-49).
--
-- Recorded decisions this migration pins (issue #203 "Decisions recorded"):
--   * Publish is idempotent on publish_key: ON CONFLICT (publish_key) DO
--     NOTHING + re-select — a retried/killed publish cannot fork two v1s.
--     `ref` carries the SAME key (the attempt-chain head reads the publishKey
--     as the ref — app/convex/versions/chain.ts:131), and ref is globally
--     UNIQUE: "a ref never freezes twice" (versioning.ts:33-35), enforced by
--     the constraint instead of the freeze transaction's lookup.
--   * Frozen rows are immutable by construction: NO insert/update/delete
--     table grants on dataset_versions/version_entries for ANY role (the
--     supabase default-privileges grant-all is revoked). The publish RPC's
--     definer path is the only writer.
--   * Tag/version retire refuses while a consumer_reference pins (#126,
--     retire-version-pin-refusal memory): consumer_references.pinned_version_id
--     is ON DELETE RESTRICT (the version cannot be deleted while pinned — the
--     FK is the guard), and the tags_guard_retire trigger refuses retiring a
--     tag whose version is still consumer-pinned.
--   * Projects are per-creator PRIVATE (stage-8 ownership, #104): RLS is
--     creator-only for projects/project_artifacts/publish_bundles/members.
--   * Publishing a locked dataset requires its creator: publish_version
--     restates can_edit_dataset (the 0005 install_tile_archive definer
--     pattern — RLS does not answer inside a definer body).

-- ---------------------------------------------------------------------------
-- §3.5 — derived_datasets (the registry table lands here; analyses are rows
-- here too — sql op kind, no separate analysis table. The derived.ts store
-- module is stage 5's; only the TABLE is stage 4's, per issue #203's goal
-- list and the §3.5 sketch.)
-- ---------------------------------------------------------------------------

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
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- The sketch's `num_non_nulls` is Postgres's `num_nonnulls` (the sketch
  -- carries the typo; the constraint is exactly its intent).
  check (num_nonnulls(source_dataset_id, source_derived_id) = 1)
);
create index derived_by_status_source on public.derived_datasets (status, coalesce(source_dataset_id, source_derived_id));
create index derived_by_source_creator on public.derived_datasets (coalesce(source_dataset_id, source_derived_id), created_by);

-- ---------------------------------------------------------------------------
-- §3.5 — dataset_versions ("a ref never freezes twice")
-- ---------------------------------------------------------------------------

create table public.dataset_versions (
  id            uuid primary key default gen_random_uuid(),
  dataset_id    uuid not null references public.datasets on delete cascade,
  ref           text not null unique,                 -- the durable version identity ("a ref never freezes twice")
  publish_key   text unique,                          -- idempotency key (retried publish cannot fork two v1s)
  version_label text not null,
  lineage       jsonb not null,                       -- recipe + source versions (lineageValidator shape, component schema.ts:33-49; camelCase keys in the jsonb)
  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index versions_by_dataset on public.dataset_versions (dataset_id, created_at desc);

-- ---------------------------------------------------------------------------
-- §3.5 — version_entries (materialized jsonb rows frozen at publish time;
-- replaces the frozen component schemas row + its re-imported entries).
-- Immutable by construction: NO table grants INSERT/UPDATE/DELETE to anyone
-- but the publish_version() definer path — not even RLS-permissive writers
-- (the supabase default-privileges grant-all is revoked below).
-- ---------------------------------------------------------------------------

create table public.version_entries (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references public.dataset_versions on delete cascade,
  entry_id      uuid references public.entries on delete set null,  -- origin (provenance only; the jsonb row is the truth)
  data          jsonb not null,
  geometry      jsonb,                                -- verbatim GeoJSON at freeze time (inline payloads; see the publish_version note on storage-backed rows)
  geometry_type text,
  bbox          double precision[4],
  ordinal       bigint not null
);
create index version_entries_by_version on public.version_entries (version_id, ordinal);

-- ---------------------------------------------------------------------------
-- §3.5 — tags (the pin as FK; retired_at null = live)
-- ---------------------------------------------------------------------------

create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets on delete cascade,
  name       text not null,
  version_id uuid not null references public.dataset_versions on delete restrict,  -- the pin, as FK
  retired_at timestamptz,                            -- null = live; a retired tag stops pinning (retention exemption reads retired_at is null)
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (dataset_id, name)
);

-- #126 retire-pin refusal as a trigger: a manual retire/delete can never
-- leave a pinned consumer dangling. Two shapes:
--   * UPDATE null -> not-null retired_at (soft retire): REFUSES while any
--     consumer_references row pins old.version_id. Refuse, never repin — a
--     pin is the consumer's explicit choice of one exact immutable version
--     (app/convex/versions/tags.ts:118-133).
--   * DELETE: same refusal (the hard path; a live/retired row's removal
--     would release the version_id FK pin the same way).
-- Version deletion while pinned needs no trigger: consumer_references and
-- tags both carry ON DELETE RESTRICT on version_id — the constraint IS the
-- guard (frozen rows are immutable by construction, above).
create function public.tags_guard_retire() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  -- A cascade (the dataset delete walking its tags via the dataset_id FK)
  -- fires this trigger at depth > 1; the consumer rows die in the same
  -- cascade (source_dataset_id → the dataset), and the whole delete must
  -- not deadlock on FK order — only DIRECT retire/delete paths are gated.
  -- The success path returns NEW for the UPDATE trigger (returning OLD would
  -- silently store the OLD row and discard the retire — a BEFORE UPDATE
  -- trigger's return value IS the row written) and OLD for the DELETE
  -- trigger (NEW is null there, and a null return would cancel the delete).
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from public.consumer_references
    where pinned_version_id = old.version_id
  ) then
    raise exception 'This version is pinned by a consumer — float or unpin that reference before retiring it.';
  end if;
  return coalesce(new, old);
end $$;

create trigger tags_guard_retire_update before update on public.tags
  for each row
  when (old.retired_at is null and new.retired_at is not null)
  execute function public.tags_guard_retire();

create trigger tags_guard_retire_delete before delete on public.tags
  for each row
  execute function public.tags_guard_retire();

-- ---------------------------------------------------------------------------
-- §3.5 — consumer_references ("consumption"; float/pin, component-parity text
-- id space: consumer_id names a derived_datasets row, a map-layer leg, or a
-- project_artifacts membership row)
-- ---------------------------------------------------------------------------

create table public.consumer_references (
  id                uuid primary key default gen_random_uuid(),
  consumer_id       text not null,
  consumer_kind     text not null check (consumer_kind in ('derived','map','fork')),
  source_dataset_id uuid references public.datasets on delete cascade,
  mode              text not null default 'float' check (mode in ('float','pin')),
  pinned_version_id uuid references public.dataset_versions on delete restrict,
  pinned_ref        text,
  created_at        timestamptz not null default now(),
  -- The Convex validators kept mode/pinnedRef/pinnedSchemaId consistent at
  -- write time ("Both absent on float", versions/tables.ts:96-98); the DB
  -- check makes it hold for EVERY writer: a pin names its row, a float
  -- carries neither field.
  check (mode <> 'pin' or pinned_version_id is not null),
  check (mode = 'pin' or (pinned_version_id is null and pinned_ref is null))
);
create index consumer_refs_by_consumer on public.consumer_references (consumer_id);
create index consumer_refs_by_source   on public.consumer_references (source_dataset_id);
create index consumer_refs_by_pin      on public.consumer_references (pinned_version_id);

-- ---------------------------------------------------------------------------
-- §3.5 — version_policies (keep-N + pinned refs per chain anchor; absence
-- reads as the defaults — DEFAULT_KEEP_VERSIONS = 10, nothing pinned — so no
-- backfill is ever required, versions/tables.ts:115-124)
-- ---------------------------------------------------------------------------

create table public.version_policies (
  dataset_key   text primary key,                     -- chain anchor id (dataset or derived row), component parity
  keep_versions integer,
  pinned_refs   text[] not null default '{}'
);

-- ---------------------------------------------------------------------------
-- §3.5 — projects (the virtual working layer) + project_artifacts
-- ---------------------------------------------------------------------------

create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text,
  artifact_count integer not null default 0,         -- denormalized, lockstep with artifacts (trigger-maintained below)
  created_by     uuid not null default auth.uid() references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index projects_by_creator on public.projects (created_by);

create table public.project_artifacts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects on delete cascade,
  artifact_id   text not null,
  artifact_kind text not null check (artifact_kind in ('dataset','derived','map')),
  added_by      uuid not null references public.profiles(id),
  unique (project_id, artifact_kind, artifact_id)
);
create index project_artifacts_by_artifact on public.project_artifacts (artifact_kind, artifact_id);

-- The artifact_count lockstep, exact for EVERY writer: the component patched
-- it "in the SAME transaction" as each membership write
-- (publishing/tables.ts:113-124) — one statement-level trigger per event
-- (the 0002 lesson: transition tables forbid multi-event triggers), set-based
-- per distinct project so multi-row statements stay exact.
create function public.projects_artifact_inserted() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.projects p
    set artifact_count = p.artifact_count + t.n
  from (
    select project_id, count(*) as n from new_table group by project_id
  ) t
  where p.id = t.project_id;
  return null;
end $$;

create function public.projects_artifact_deleted() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.projects p
    set artifact_count = p.artifact_count - t.n
  from (
    select project_id, count(*) as n from old_table group by project_id
  ) t
  where p.id = t.project_id;
  return null;
end $$;

create trigger project_artifacts_count_insert after insert on public.project_artifacts
  referencing new table as new_table
  for each statement execute function public.projects_artifact_inserted();

create trigger project_artifacts_count_delete after delete on public.project_artifacts
  referencing old table as old_table
  for each statement execute function public.projects_artifact_deleted();

-- ---------------------------------------------------------------------------
-- §3.5 — publish_bundles + publish_bundle_members (the bundle press;
-- component bundleRuns/bundleRunMembers)
-- ---------------------------------------------------------------------------

create table public.publish_bundles (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects on delete cascade,
  title               text not null,
  project_description text,
  collection_id       uuid references public.collections on delete set null,  -- created once, reused across presses
  status              text not null default 'running' check (status in ('running','completed','failed')),
  error               text,
  created_by          uuid not null references public.profiles(id),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  last_progress_at    timestamptz not null default now()
);
create index bundles_by_project on public.publish_bundles (project_id, started_at desc);

create table public.publish_bundle_members (
  id                   uuid primary key default gen_random_uuid(),
  bundle_id            uuid not null references public.publish_bundles on delete cascade,
  kind                 text not null check (kind in ('dataset','derived','map')),
  dataset_key          text not null,
  group_id             uuid,                          -- component group id parity (plain, no FK: the press carries the draft's group id as recorded; a dangling group renders nothing, the 0005 dangling-target tolerance)
  publish              boolean not null default true,
  status               text not null default 'pending' check (status in
                       ('pending','publishing','published','referenced','linked','failed')),
  published_version_id uuid references public.dataset_versions on delete set null,
  attempt_id           uuid,
  layer_targets        text[],
  error                text
);
create index bundle_members_by_bundle on public.publish_bundle_members (bundle_id);

-- ---------------------------------------------------------------------------
-- §3 conventions — attribution + updated_at maintenance (the 0003/0005/0007
-- pattern: identity stamped from the request, never claimed from a payload;
-- the stamp runs BEFORE the RLS WITH CHECK so the checked row carries the
-- invoker's id). dataset_versions carries no default and no stamp: its only
-- writer is publish_version (definer), which passes auth.uid() explicitly.
-- ---------------------------------------------------------------------------

create trigger derived_datasets_stamp_created_by before insert on public.derived_datasets
  for each row execute function public.stamp_created_by();
create trigger derived_datasets_set_updated_at before update on public.derived_datasets
  for each row execute function public.set_updated_at();

create trigger projects_stamp_created_by before insert on public.projects
  for each row execute function public.stamp_created_by();
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

create trigger tags_stamp_created_by before insert on public.tags
  for each row execute function public.stamp_created_by();

create trigger publish_bundles_stamp_created_by before insert on public.publish_bundles
  for each row execute function public.stamp_created_by();

-- project_artifacts.added_by rides the same attribution rule (the component
-- stamped it to the caller, publishing/tables.ts:137-139) — a one-column
-- stamp, the 0005 layer_styles_stamp_updated_by pattern.
create function public.project_artifacts_stamp_added_by() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  new.added_by := auth.uid();
  return new;
end $$;

create trigger project_artifacts_stamp_added_by before insert on public.project_artifacts
  for each row execute function public.project_artifacts_stamp_added_by();

-- ---------------------------------------------------------------------------
-- Immutability by construction (issue #203, §4): the supabase default
-- privileges grant ALL on new tables (verified: pg_default_acl grants
-- arwdDxt to anon/authenticated/service_role) — revoke every mutation right
-- on the frozen tables for EVERY role. The publish RPC runs as the definer
-- (owner), which needs no grants. SELECT stays grantable (RLS gates it).
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger
  on public.dataset_versions, public.version_entries
  from anon, authenticated, service_role;

-- artifact_count is trigger-maintained (the 0003 column-grant pattern): a
-- client-writable counter would drift from the membership rows it mirrors.
revoke update on public.projects from authenticated;
grant update (title, description) on public.projects to authenticated;

-- ---------------------------------------------------------------------------
-- §5.4 — publish_version (frozen materialization). SECURITY DEFINER: the
-- version tables carry no client grants (above), and the materialization
-- reads entries/geometries across the dataset regardless of the caller's
-- row visibility — the freeze is a host-side atomic act, exactly like the
-- Convex freeze (the internal-mutation rule, versioning.ts:282-308).
--
-- Definer choices recorded (the 0005 install_tile_archive precedent — each
-- definer function restates the §4 gate it bypasses):
--   * publish_version restates can_edit_dataset (open = any signed-in user —
--     trusted collaborator ADR 0009; locked = creator only, ADR 0010; frozen
--     = nobody), so "publishing a locked dataset requires its creator"
--     (issue #203) holds and a frozen row can never re-freeze.
--   * enforce_version_retention restates owner-or-editor: the keep-N write is
--     the chain owner's (assertChainAnchorWritable,
--     consumption.ts:539-545) and the publisher's internal call rides the
--     can_edit_dataset arm.
-- ---------------------------------------------------------------------------

create function public.enforce_version_retention(p_dataset uuid) returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_keep integer;
  v_retired integer := 0;
begin
  -- The caller gate (see the definer note above): the chain's owner, or an
  -- editor of the dataset (publish_version's internal hook).
  select coalesce(pol.keep_versions, 10) into v_keep   -- DEFAULT_KEEP_VERSIONS (versioning.ts:46)
  from public.datasets d
  left join public.version_policies pol on pol.dataset_key = d.id::text
  where d.id = p_dataset
    and (d.created_by = auth.uid() or public.can_edit_dataset(p_dataset));
  if v_keep is null then
    raise exception 'enforce_version_retention: caller is not the chain owner or an editor of the dataset';
  end if;

  -- Retire the versions past keep-N, exempting (versionsToRetire +
  -- "pinned versions never auto-retire", versioning.ts:91-112 and
  -- tags.ts:561): policy-pinned refs, consumer-pinned rows, and live tags.
  -- The version_id RESTRICT FKs make the order matter (WITH-side
  -- data-modifying statements execute in unpredictable order), so the
  -- stale-tag cleanup is its OWN statement BEFORE the version delete, with
  -- the victim CTE inlined in both: retired tag rows on victims go first
  -- (the host cascade parity — issue #128: "the cascade cleans only rows
  -- keyed by the version itself"); their guard trigger cannot refuse,
  -- because victims are unconsumer-pinned.
  with ranked as (
    select v.id,
           row_number() over (order by v.created_at desc, v.id desc) as recency
    from public.dataset_versions v
    where v.dataset_id = p_dataset
      and not exists (
        select 1 from public.version_policies pol
        where pol.dataset_key = p_dataset::text
          and v.ref = any (pol.pinned_refs)
      )
      and not exists (
        select 1 from public.consumer_references cr
        where cr.pinned_version_id = v.id
      )
      and not exists (
        select 1 from public.tags t
        where t.version_id = v.id and t.retired_at is null
      )
  )
  delete from public.tags t
  using ranked r
  where t.version_id = r.id and r.recency > v_keep and t.retired_at is not null;

  with ranked as (
    select v.id,
           row_number() over (order by v.created_at desc, v.id desc) as recency
    from public.dataset_versions v
    where v.dataset_id = p_dataset
      and not exists (
        select 1 from public.version_policies pol
        where pol.dataset_key = p_dataset::text
          and v.ref = any (pol.pinned_refs)
      )
      and not exists (
        select 1 from public.consumer_references cr
        where cr.pinned_version_id = v.id
      )
      and not exists (
        select 1 from public.tags t
        where t.version_id = v.id and t.retired_at is null
      )
  )
  delete from public.dataset_versions v
  using ranked r
  where v.id = r.id and r.recency > v_keep;
  get diagnostics v_retired = row_count;
  return v_retired;
end $$;

create function public.publish_version(
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

  -- "A ref never freezes twice" (the global by-ref re-check,
  -- versioning.ts:262-269): a ref frozen under ANY chain answers its
  -- existing version id — the Convex freeze short-circuit.
  select id into v_id from public.dataset_versions where ref = p_publish_key;
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
    -- Lost the idempotency race to the concurrent winner: return ITS row.
    select id into v_id from public.dataset_versions where publish_key = p_publish_key;
    return v_id;
  end if;

  -- The materialization (§5.4): set-based INSERT..SELECT over the live
  -- entries left joined to their inline geometry, frozen verbatim.
  -- entry_id is provenance only — the jsonb row is the truth. `ordinal` is
  -- the dataset's stable read order (created_at, id — the
  -- entries_dataset_created index), so paged frozen reads are keyset-stable.
  -- KNOWN LIMITATION (recorded): storage-backed oversized geometries
  -- (> 256 KB, geometries.source_path set, source null) carry NO geometry
  -- into version_entries — the RPC cannot read Storage. Their frozen rows
  -- freeze the data jsonb only; the tile path keeps serving the live
  -- dataset. Flagged for the stage-5 review.
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
-- RLS owner-rule helpers. INVOKER + `stable` (not definer: the policies run
-- with the invoker's identity, and a helper reading OTHER tables — never the
-- policy's own table — cannot trip the 0008 trap, where a definer helper
-- reading the same table saw the just-inserted row as invisible on
-- INSERT..RETURNING).
-- ---------------------------------------------------------------------------

create function public.consumer_reference_owner(p_kind text, p_consumer text)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select p_kind = 'map'
    or exists (
    select 1
    from public.project_artifacts pa
    join public.projects pr on pr.id = pa.project_id
    where pa.id::text = p_consumer and pr.created_by = auth.uid()
  )
  or exists (
    select 1 from public.derived_datasets dd
    where dd.id::text = p_consumer and dd.created_by = auth.uid()
  )
$$;

create function public.version_policy_anchor_owner(p_anchor text)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id::text = p_anchor and d.created_by = auth.uid()
  )
  or exists (
    select 1 from public.derived_datasets dd
    where dd.id::text = p_anchor and dd.created_by = auth.uid()
  )
$$;

create function public.project_artifact_owner(p_project uuid)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project and p.created_by = auth.uid()
  )
$$;

create function public.publish_bundle_owner(p_bundle uuid)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select exists (
    select 1 from public.publish_bundles b
    where b.id = p_bundle and b.created_by = auth.uid()
  )
$$;

-- ---------------------------------------------------------------------------
-- §4 — RLS (the matrix's version-table rows; anon gets nothing).
--
-- The 0008 lesson (INSERT .. RETURNING evaluates the SELECT policy on the
-- new row): the browser-writable tables below gate SELECT on the row's OWN
-- attribution columns or on OTHER tables' rows — never on a definer helper
-- reading the row's own table — so reading back a just-written row cannot
-- fail closed. dataset_versions/version_entries have no client write path at
-- all, so their helper-gated SELECTs are safe.
-- ---------------------------------------------------------------------------

alter table public.derived_datasets    enable row level security;
alter table public.dataset_versions    enable row level security;
alter table public.version_entries     enable row level security;
alter table public.tags                enable row level security;
alter table public.consumer_references enable row level security;
alter table public.version_policies    enable row level security;
alter table public.projects            enable row level security;
alter table public.project_artifacts   enable row level security;
alter table public.publish_bundles     enable row level security;
alter table public.publish_bundle_members enable row level security;

-- derived_datasets — matrix: authenticated (drafts invisible to consumers by
-- the status column, component parity); UPDATE may not change created_by.
create policy "derived_datasets select: authenticated"
  on public.derived_datasets for select to authenticated using (true);
create policy "derived_datasets insert: authenticated"
  on public.derived_datasets for insert to authenticated with check (true);
create policy "derived_datasets update: authenticated, creator kept"
  on public.derived_datasets for update to authenticated
  using (true) with check (created_by = auth.uid());
create policy "derived_datasets delete: authenticated"
  on public.derived_datasets for delete to authenticated using (true);

-- dataset_versions — SELECT via can_view_dataset (helper-gated is safe: no
-- client write path exists, so no INSERT..RETURNING can hit it).
create policy "dataset_versions select: can_view_dataset"
  on public.dataset_versions for select to authenticated
  using (public.can_view_dataset(dataset_id));

-- version_entries — SELECT through the version join.
create policy "version_entries select: can_view_dataset via the version"
  on public.version_entries for select to authenticated
  using (
    exists (
      select 1 from public.dataset_versions v
      where v.id = version_id
        and public.can_view_dataset(v.dataset_id)
    )
  );

-- tags — matrix: authenticated read+write (+ the retire guard trigger).
create policy "tags select: authenticated"
  on public.tags for select to authenticated using (true);
create policy "tags insert: authenticated"
  on public.tags for insert to authenticated with check (true);
create policy "tags update: authenticated"
  on public.tags for update to authenticated using (true) with check (true);
create policy "tags delete: authenticated"
  on public.tags for delete to authenticated using (true);

-- consumer_references — SELECT authenticated (the badge/consumed-by walks
-- read rows by source across consumers); writes carry the stage-8
-- assertConsumerWritable rule (consumption.ts:509-530) as RLS: map edges are
-- the recorded exception (shared catalog artifacts — any signed-in user),
-- fork edges belong to the membership's project's creator, derived edges to
-- the registry row's creator.
create policy "consumer_references select: authenticated"
  on public.consumer_references for select to authenticated using (true);

create policy "consumer_references write: consumer owner"
  on public.consumer_references for insert to authenticated
  with check (public.consumer_reference_owner(consumer_kind, consumer_id));

create policy "consumer_references write: consumer owner (update)"
  on public.consumer_references for update to authenticated
  using (public.consumer_reference_owner(consumer_kind, consumer_id))
  with check (public.consumer_reference_owner(consumer_kind, consumer_id));

create policy "consumer_references write: consumer owner (delete)"
  on public.consumer_references for delete to authenticated
  using (public.consumer_reference_owner(consumer_kind, consumer_id));

-- version_policies — the assertChainAnchorWritable rule (the anchor's owner
-- writes it; consumption.ts:539-545) on BOTH sides: a foreign anchor's row
-- is invisible, so every policy read answers the defaults exactly as the
-- Convex retentionSettings did ("an invisible anchor answers the defaults —
-- indistinguishable from a chain with no stored policy", tags.ts:636-641).
-- Recorded deviation from the §4 matrix row ("authenticated" read): the
-- Convex read-behavior wins, because the matrix row is the sketch-level
-- floor and the anchor's keep/pinnedRefs shape another chain's retention.
create policy "version_policies read/write: anchor owner"
  on public.version_policies for select to authenticated
  using (public.version_policy_anchor_owner(dataset_key));
create policy "version_policies insert: anchor owner"
  on public.version_policies for insert to authenticated
  with check (public.version_policy_anchor_owner(dataset_key));
create policy "version_policies update: anchor owner"
  on public.version_policies for update to authenticated
  using (public.version_policy_anchor_owner(dataset_key))
  with check (public.version_policy_anchor_owner(dataset_key));
create policy "version_policies delete: anchor owner"
  on public.version_policies for delete to authenticated
  using (public.version_policy_anchor_owner(dataset_key));

-- projects + project_artifacts — creator only (the stage-8 private
-- exception, #104). publish bundles/members are project state: same rule,
-- through the bundle's/project's creator.
create policy "projects select: creator"
  on public.projects for select to authenticated using (created_by = auth.uid());
create policy "projects insert: creator"
  on public.projects for insert to authenticated with check (created_by = auth.uid());
create policy "projects update: creator"
  on public.projects for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy "projects delete: creator"
  on public.projects for delete to authenticated using (created_by = auth.uid());

create policy "project_artifacts select: project creator"
  on public.project_artifacts for select to authenticated
  using (public.project_artifact_owner(project_id));
create policy "project_artifacts insert: project creator"
  on public.project_artifacts for insert to authenticated
  with check (public.project_artifact_owner(project_id));
create policy "project_artifacts update: project creator"
  on public.project_artifacts for update to authenticated
  using (public.project_artifact_owner(project_id))
  with check (public.project_artifact_owner(project_id));
create policy "project_artifacts delete: project creator"
  on public.project_artifacts for delete to authenticated
  using (public.project_artifact_owner(project_id));

create policy "publish_bundles select: creator"
  on public.publish_bundles for select to authenticated using (created_by = auth.uid());
create policy "publish_bundles insert: creator"
  on public.publish_bundles for insert to authenticated with check (created_by = auth.uid());
create policy "publish_bundles update: creator"
  on public.publish_bundles for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy "publish_bundles delete: creator"
  on public.publish_bundles for delete to authenticated using (created_by = auth.uid());

create policy "publish_bundle_members select: bundle creator"
  on public.publish_bundle_members for select to authenticated
  using (public.publish_bundle_owner(bundle_id));
create policy "publish_bundle_members insert: bundle creator"
  on public.publish_bundle_members for insert to authenticated
  with check (public.publish_bundle_owner(bundle_id));
create policy "publish_bundle_members update: bundle creator"
  on public.publish_bundle_members for update to authenticated
  using (public.publish_bundle_owner(bundle_id))
  with check (public.publish_bundle_owner(bundle_id));
create policy "publish_bundle_members delete: bundle creator"
  on public.publish_bundle_members for delete to authenticated
  using (public.publish_bundle_owner(bundle_id));

-- ---------------------------------------------------------------------------
-- Carry-over fix (stage-4 review tranche): collection_datasets write
-- policies tightened (0007 shipped them as plain `authenticated`/true).
-- The Convex host hook gated EVERY write operation's named datasets on
-- visibility AND the edit policy — organization (membership) ops included,
-- "no carve-outs" (app/convex/auth.ts:249-258, assertDatasetsWritable over
-- every write type; cms/sharing.test.ts:509-519 asserts the LOCK rejection
-- on addSchemaToCollection/setSchemaGroup). Stage 4's frozen datasets make
-- the 0007 gap reachable. This is a DELIBERATE DEVIATION from §4's matrix
-- row (collection_datasets: authenticated write) — the host-hook behavior
-- the issue #202 stage bound on wins.
--
-- Notes on the gate's exact shape:
--   * can_view_dataset(dataset_id) = the assertDatasetsVisible half (drafts
--     and author-only rows answer their creator alone; invisible reads as
--     not-found).
--   * can_edit_dataset(dataset_id) = the assertDatasetWritable half (locked
--     = creator only). Its `lineage is null` arm additionally denies
--     membership writes on frozen/bound rows to EVERYONE — STRICTER than
--     the Convex hook, which allowed organization ops on read-only datasets
--     ("the data is read-only, not the filing", auth.ts:231). Deliberate:
--     no PG client path sets lineage until stage 7's bound freezes, and a
--     frozen row refusing writes for everyone is the §4 rule can_edit_dataset
--     already carries for every other table.
--   * SELECT stays plain authenticated (the membership row is inert; the
--     datasets embed filters visibility) — the matrix row for reads stands.
-- ---------------------------------------------------------------------------

drop policy if exists "collection_datasets insert: authenticated" on public.collection_datasets;
drop policy if exists "collection_datasets update: authenticated" on public.collection_datasets;
drop policy if exists "collection_datasets delete: authenticated" on public.collection_datasets;

create policy "collection_datasets insert: dataset viewable + editable"
  on public.collection_datasets for insert to authenticated
  with check (public.can_view_dataset(dataset_id) and public.can_edit_dataset(dataset_id));
create policy "collection_datasets update: dataset viewable + editable"
  on public.collection_datasets for update to authenticated
  using (public.can_view_dataset(dataset_id) and public.can_edit_dataset(dataset_id))
  with check (public.can_view_dataset(dataset_id) and public.can_edit_dataset(dataset_id));
create policy "collection_datasets delete: dataset viewable + editable"
  on public.collection_datasets for delete to authenticated
  using (public.can_view_dataset(dataset_id) and public.can_edit_dataset(dataset_id));

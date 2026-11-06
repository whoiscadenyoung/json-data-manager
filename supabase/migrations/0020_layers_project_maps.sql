-- Layers & project-owned maps (issue #257 — the project-centric train,
-- phase 3; docs/project-centric-experience-design.md §4.1, §4.3, §7 D2/D6;
-- ADR 0019, porting the preserved branch's phase 3
-- docs/project-workspace-design.md §3 to the Postgres backend).
--
-- The model (ArcGIS/QGIS decoupling — style never modifies data):
--   * `layers` — the style/filter/labels/popup unit, PROJECT-OWNED from
--     birth (no standalone layers). Kind `data` (one dataset membership of
--     the same project + the style that paints it) or `group` (an ordered
--     set of children — groups are layers, so they publish/link/clone
--     exactly like data layers).
--   * `layer_children` — rows, not arrays: `[group_id, order]`, each child
--     OWNED (a layers row of the same project) or LINKED (a pinned
--     layer_versions row). Nesting lives only inside groups; cycles are
--     rejected at edit time (client guard, depth-bound parent walk).
--   * `layer_versions` — the append-only frozen published definition chain
--     (mirrors dataset versioning: rows never mutate, newest per layer is
--     the head). A data version pins its dataset ref at publish; a group
--     version freezes its children's pinned versions.
--   * `maps` becomes PROJECT-OWNED (project_id NOT NULL + order/viewport/
--     basemap — the projectMaps shape): the pre-0019 standalone rows fold
--     into one per-creator project (data-disposable posture — this is the
--     one in-migration backfill the train's handoff allows; not an adoption
--     phase). Maps are project ROWS, never project_artifacts memberships
--     (the branch's phase-3 retirement — membership-kind "map" stays dead).
--   * `map_layers` retargets to LAYER PLACEMENTS: each row names a layer
--     MEMBERSHIP (a project_artifacts row of kind 'layer' in the map's own
--     project — owned layers answer via their layers row, linked via their
--     pinned layer_versions row). The old direct dataset/collection/group
--     target modes retire; with them, `map_layer_overrides` (child
--     visibility of an expanded collection/group target — the layers tree
--     replaces it) and `layer_styles` (per-(map, renderId) style fragments —
--     layers.style is the storage of record now) RETIRE. `marker_sprites`
--     stays (point-marker icons are orthogonal; the style editor keeps
--     using them).
--   * `project_artifacts` kind domain widens to dataset|derived|layer.
--     Clients cannot addArtifact a layer (the layers store mints layer
--     memberships internally at create/link — "layers join by create/link
--     only", branch parity); the DB check accepts it for those writes.
--
-- Realtime: `layers` + `layer_children` join the publication (guarded, the
-- 0013/0015 pattern — the in-project map editor live-updates on layer
-- edits); `layer_styles` leaves it (its table dies). `map_layers` is
-- already a member (0013) and keeps its slot under the new shape.

-- ---------------------------------------------------------------------------
-- §1 — layers
-- ---------------------------------------------------------------------------

create table public.layers (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects on delete cascade,
  kind              text not null check (kind in ('data','group')),
  -- The only required field (the UI rule: name required, the rest optional).
  name              text not null,
  -- Data kind: the dataset membership this layer styles — a project_artifacts
  -- row (kind 'dataset') of the SAME project. CASCADE: removing the
  -- membership removes the layers styling it (a layer without its data is
  -- nothing). Null on groups (meaningless there).
  dataset_member_id uuid references public.project_artifacts on delete cascade,
  -- MapLibre style-spec fragment (@caden/layer-styles validators validate
  -- the shape; never widened here). '{}' = the assigned-color default.
  style             jsonb not null default '{}'::jsonb,
  filter            jsonb,
  labels            jsonb,
  popup             jsonb,
  -- The group kind's group-level transparency (0–1); null = opaque default.
  opacity           double precision check (opacity between 0 and 1),
  visible           boolean not null default true,
  -- "draft" (the working definition, project-visible) vs "published" (a
  -- version exists). Existence of a layer_versions row — not this marker —
  -- gates link/clone (the existence-over-marker rule).
  lifecycle         text not null default 'draft' check (lifecycle in ('draft','published')),
  -- The drift message — set when the source dataset's schema moves under a
  -- styled layer, cleared by the layer's next styling write. A string (why),
  -- not a boolean (the UI says what moved).
  needs_attention   text,
  created_by        uuid not null default auth.uid() references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- The project's Layers section and its role checks.
create index layers_by_project on public.layers (project_id);
-- The drift stamp's target walk ("which layers style this dataset's
-- membership") and the membership-removal cascade's read.
create index layers_by_member on public.layers (dataset_member_id);

create trigger layers_stamp_created_by before insert on public.layers
  for each row execute function public.stamp_created_by();
create trigger layers_set_updated_at before update on public.layers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- §2 — layer_children (rows, not arrays; nesting lives only inside groups)
-- ---------------------------------------------------------------------------

create table public.layer_children (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references public.layers on delete cascade,
  -- "owned": child_layer_id is a layers row of the same project. "linked":
  -- child_layer_id is a PINNED layer_versions row id — a foreign published
  -- layer's frozen version, referenced read-only.
  child_kind     text not null check (child_kind in ('owned','linked')),
  -- uuid across TWO id spaces by child_kind — NO FK by design (the old
  -- map_layers.target_id precedent): one column cannot reference two
  -- tables, and the guards that read it always filter by child_kind first.
  child_layer_id uuid not null,
  -- Draw/list position; written contiguously, gaps allowed after removals
  -- (only relative order renders — the map_layers "order" rule).
  "order"        integer not null,
  -- One placement of a child in a group (the map_layers-by-map shape's
  -- uniqueness, applied to the tree).
  unique (group_id, child_kind, child_layer_id)
);
-- The group's ordered read (an index scan IS the child list).
create index layer_children_by_group on public.layer_children (group_id, "order");
-- The parent lookup ("which group holds this child") — the cycle guard's
-- and reparent's walk. Without it every parent check scans the table.
create index layer_children_by_child on public.layer_children (child_layer_id);

-- ---------------------------------------------------------------------------
-- §3 — layer_versions (the append-only frozen definition chain)
-- ---------------------------------------------------------------------------

create table public.layer_versions (
  id            uuid primary key default gen_random_uuid(),
  layer_id      uuid not null references public.layers on delete cascade,
  version_label text not null,
  -- The frozen definition: name/style/filter/labels/popup/opacity/visible
  -- as they were at publish (shapeless jsonb like every stored spec — a
  -- typed check would fork from the live row's fields they mirror).
  definition    jsonb not null,
  -- Data kind: the resolved dataset ref at publish — {sourceMemberId,
  -- pinnedVersionId, pinnedRef} (the layer's data is pinned at publish, so
  -- later membership syncs never move a published layer's DATA — the
  -- frozen DEFINITION and the pin live here; [project 5]'s snapshot work
  -- renders from them). Null on group versions.
  dataset       jsonb,
  -- Group versions freeze their children's pinned versions: each child as
  -- it was — {childKind, childLayerId, versionId?} (a frozen snapshot of a
  -- human-scale group at a publish event; the rows-not-arrays rule governs
  -- the MUTABLE tree, exactly as publish_bundle_members' rows govern the
  -- press while its plan arrays stay bounded).
  frozen_children jsonb,
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now()
);
-- The version chain: a layer's published history, newest first.
create index layer_versions_by_layer on public.layer_versions (layer_id, created_at desc);

create trigger layer_versions_stamp_created_by before insert on public.layer_versions
  for each row execute function public.stamp_created_by();

-- ---------------------------------------------------------------------------
-- §4 — maps: project-owned (the projectMaps shape) + the standalone backfill
-- ---------------------------------------------------------------------------

alter table public.maps
  add column project_id uuid references public.projects on delete cascade,
  add column "order"    integer not null default 0,
  add column viewport   jsonb,
  add column basemap    text;

-- The one in-migration backfill: every standalone map folds into a
-- per-creator project ("Maps of <name>" — a real project with the creator
-- as its owner member), so the project-owned RLS below locks nobody out
-- and no map is orphaned. The birth trigger mints the owner membership
-- with each project (the 0018 invariant, for every writer).
do $$
declare
  m record;
  pid uuid;
begin
  for m in
    select distinct on (created_by) created_by, id
    from public.maps
    where project_id is null
    order by created_by, id
  loop
    insert into public.projects (title, description, created_by)
    values (
      coalesce((select name from public.profiles where id = m.created_by), 'Someone') || '''s maps',
      'Project holding the maps created before maps became project-owned (backfilled 2026-11-06).',
      m.created_by
    )
    returning id into pid;
    update public.maps set project_id = pid where created_by = m.created_by and project_id is null;
  end loop;
end
$$;

alter table public.maps alter column project_id set not null;
create index maps_by_project on public.maps (project_id, "order");

-- Maps are project ROWS (never memberships): reads are member-wide, writes
-- are editor+ (the 0018 helpers; D2 — the /maps explorer lists every map
-- the viewer can see, creation lives in projects). The four 0005
-- authenticated-wide policies are dropped and rewritten.
drop policy if exists "maps select: authenticated" on public.maps;
drop policy if exists "maps insert: authenticated" on public.maps;
drop policy if exists "maps update: authenticated" on public.maps;
drop policy if exists "maps delete: authenticated" on public.maps;
create policy "maps select: project member"
  on public.maps for select to authenticated
  using (public.can_view_project(project_id));
create policy "maps insert: project editor"
  on public.maps for insert to authenticated
  with check (public.can_edit_project(project_id));
create policy "maps update: project editor"
  on public.maps for update to authenticated
  using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id));
create policy "maps delete: project editor"
  on public.maps for delete to authenticated
  using (public.can_edit_project(project_id));

-- ---------------------------------------------------------------------------
-- §5 — map_layers: the placement retarget; overrides + layer_styles retire
-- ---------------------------------------------------------------------------

-- Child-visibility overrides expanded the old collection/group targets;
-- the layers tree owns child visibility now (placement visible + layer
-- visible). The style fragments move onto the layer rows (layers.style).
drop table if exists public.map_layer_overrides;
drop table if exists public.layer_styles;
drop table if exists public.map_layers;

create table public.map_layers (
  id              uuid primary key default gen_random_uuid(),
  map_id          uuid not null references public.maps on delete cascade,
  "order"         integer not null,
  -- The layer MEMBERSHIP (a project_artifacts row of kind 'layer' in the
  -- map's own project): owned layers answer via their layers row (the
  -- membership's artifact_id), linked ones via their pinned layer_versions
  -- row (the membership's artifact_id IS the pin). CASCADE: removing the
  -- membership removes its placements.
  layer_member_id uuid not null references public.project_artifacts on delete cascade,
  -- The map-local visibility toggle (the layer's own `visible` stays the
  -- layer-wide default; "link = read-only pinned unit, local visibility
  -- toggles only").
  visible         boolean not null default true
);
-- Draw order (the 0005 by_map shape, unchanged in spirit).
create index map_layers_by_map on public.map_layers (map_id, "order");
create index map_layers_by_member on public.map_layers (layer_member_id);

-- The old target-mode policies were authenticated-wide; the placement rows
-- ride their map's project now. RLS must be RE-ENABLED explicitly: the
-- DROP TABLE above took the old enablement with it, and a recreated table
-- ships with RLS off — its four policies below would be inert decoration
-- (the int test caught exactly that: a viewer updated a placement).
alter table public.map_layers enable row level security;
drop policy if exists "map_layers select: authenticated" on public.map_layers;
drop policy if exists "map_layers insert: authenticated" on public.map_layers;
drop policy if exists "map_layers update: authenticated" on public.map_layers;
drop policy if exists "map_layers delete: authenticated" on public.map_layers;
create policy "map_layers select: map project member"
  on public.map_layers for select to authenticated
  using (
    exists (
      select 1 from public.maps m where m.id = map_id and public.can_view_project(m.project_id)
    )
  );
create policy "map_layers insert: map project editor"
  on public.map_layers for insert to authenticated
  with check (
    exists (
      select 1 from public.maps m where m.id = map_id and public.can_edit_project(m.project_id)
    )
  );
create policy "map_layers update: map project editor"
  on public.map_layers for update to authenticated
  using (
    exists (
      select 1 from public.maps m where m.id = map_id and public.can_edit_project(m.project_id)
    )
  )
  with check (
    exists (
      select 1 from public.maps m where m.id = map_id and public.can_edit_project(m.project_id)
    )
  );
create policy "map_layers delete: map project editor"
  on public.map_layers for delete to authenticated
  using (
    exists (
      select 1 from public.maps m where m.id = map_id and public.can_edit_project(m.project_id)
    )
  );

-- The retired tables' policies die with their tables (the DROPs above);
-- the remaining 0005 grants on them die with the transaction too.

-- ---------------------------------------------------------------------------
-- §6 — layers / layer_children / layer_versions RLS (the 0018 role split:
-- reads member-wide, content writes editor+; row-local through project_id
-- wherever possible — the publish_bundles policy shape)
-- ---------------------------------------------------------------------------

alter table public.layers enable row level security;
create policy "layers select: project member"
  on public.layers for select to authenticated
  using (public.can_view_project(project_id));
create policy "layers insert: project editor"
  on public.layers for insert to authenticated
  with check (public.can_edit_project(project_id) and created_by = auth.uid());
create policy "layers update: project editor"
  on public.layers for update to authenticated
  using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id));
create policy "layers delete: project editor"
  on public.layers for delete to authenticated
  using (public.can_edit_project(project_id));

alter table public.layer_children enable row level security;
create policy "layer_children select: group project member"
  on public.layer_children for select to authenticated
  using (
    exists (
      select 1 from public.layers l where l.id = group_id and public.can_view_project(l.project_id)
    )
  );
create policy "layer_children insert: group project editor"
  on public.layer_children for insert to authenticated
  with check (
    exists (
      select 1 from public.layers l where l.id = group_id and public.can_edit_project(l.project_id)
    )
  );
create policy "layer_children update: group project editor"
  on public.layer_children for update to authenticated
  using (
    exists (
      select 1 from public.layers l where l.id = group_id and public.can_edit_project(l.project_id)
    )
  )
  with check (
    exists (
      select 1 from public.layers l where l.id = group_id and public.can_edit_project(l.project_id)
    )
  );
create policy "layer_children delete: group project editor"
  on public.layer_children for delete to authenticated
  using (
    exists (
      select 1 from public.layers l where l.id = group_id and public.can_edit_project(l.project_id)
    )
  );

alter table public.layer_versions enable row level security;
create policy "layer_versions select: layer project member"
  on public.layer_versions for select to authenticated
  using (
    exists (
      select 1 from public.layers l where l.id = layer_id and public.can_view_project(l.project_id)
    )
  );
-- Freezing a version is a content write (editor+); versions never mutate or
-- delete (append-only — no update/delete policies at all, the
-- dataset_versions posture).
create policy "layer_versions insert: layer project editor"
  on public.layer_versions for insert to authenticated
  with check (
    exists (
      select 1 from public.layers l where l.id = layer_id and public.can_edit_project(l.project_id)
    )
  );

-- ---------------------------------------------------------------------------
-- §7 — project_artifacts: kind domain widens to dataset|derived|layer.
-- Maps stay OUT (project rows, never memberships — §4). Memberships of
-- kind 'layer' are minted by the layers store ONLY (create/link); the
-- client-facing addArtifact keeps refusing it at the type level.
-- ---------------------------------------------------------------------------

alter table public.project_artifacts drop constraint project_artifacts_artifact_kind_check;
alter table public.project_artifacts
  add constraint project_artifacts_artifact_kind_check
  check (artifact_kind in ('dataset','derived','layer'));

-- ---------------------------------------------------------------------------
-- §8 — realtime: layers + layer_children join the publication (the editor
-- live-updates on layer edits); layer_styles leaves it (its table died).
-- Maps themselves stay out (their channel would need per-map filtering the
-- same way projects got one in 0018 — the editor's TanStack invalidation
-- covers it for now; joining maps is a later need, not this phase's).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

do $$
declare
  -- map_layers re-joins explicitly: DROP TABLE (the retarget above)
  -- detaches a publication member automatically, and the recreated table
  -- does not come back on its own.
  members text[] := array['layers', 'layer_children', 'map_layers'];
  t text;
begin
  foreach t in array members loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
  -- The retired table leaves the publication (a publication member whose
  -- table is dropped would break the publication's next refresh).
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'layer_styles'
  ) then
    execute 'alter publication supabase_realtime drop table public.layer_styles';
  end if;
end
$$;

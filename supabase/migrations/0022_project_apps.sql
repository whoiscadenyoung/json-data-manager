-- Apps in projects — stored-map widgets + app freeze/publish (issue #259 —
-- the project-centric train, phase 5; docs/project-centric-experience-design.md
-- §4.1 apps bullet, §5 step 4, §7 D7; ADR 0021).
--
-- The model (D7 — app↔map coupling through stored maps):
--   * `apps.project_id` NOT NULL — apps are project-owned rows whose reads
--     are member-wide and whose writes are project-editor+ (the 0018 role
--     split, exactly the 0020 maps posture; the 0014 creator-gate dies).
--     The map widget's `datasetIds` array mode RETIRES — a widget carries
--     `mapId`, a reference to a stored project map ("a map built anywhere in
--     the app is a map row — no inline-only mode survives"). Pre-0022 apps
--     keep their rows (ownership backfill below) but their inline maps are
--     NOT rewritten into map rows — no adoption steps; a disposable-dev
--     dataset carries broken map widgets honestly (the widget renders
--     "choose a map") rather than a clever silent conversion.
--   * `app_versions` — the append-only frozen publish chain mirroring
--     `layer_versions` (0020): rows never mutate, newest per app is the
--     head. `definition` freezes title/description, the pages jsonb
--     verbatim, datasetPins (head version id + ref + frozen title/schema/
--     bbox per referenced dataset — no chain yet = honest nulls),
--     mapSnapshots (per referenced map: name/viewport/basemap + placements
--     as {order, visible, versionId}) and a flattened layerVersions list
--     (each referenced layer_versions row's definition + resolved dataset
--     pin + frozenChildren). The published viewer renders ONLY from the
--     snapshot + immutable version_entries — editing the live map cannot
--     move a published app until republish. The bundle press stays the
--     convenience closure over per-artifact publishes ([project 6]); it is
--     not the per-app freeze.
--   * `project_artifacts` kind domain widens to dataset|derived|layer|app.
--     The apps store mints the kind-'app' OWNED membership at create (the
--     layers-store pattern — clients cannot addArtifact an app); this
--     migration backfills one membership per existing app row.
--   * Seeded examples: the two example apps move into a "System examples"
--     PROJECT (fixed uuid) that owns the full chain — dataset memberships,
--     the parks layer, the example map, its placement — and each example
--     app ships a PUBLISHED app_versions row (v1) whose snapshot renders
--     the frozen map. Reads stay example-wide: the ONE new visibility arm
--     is `or example is true` on apps' SELECT (what 0014's flat read
--     granted, narrowed to the flag) — the unified visibility ladder is
--     [project 6]'s, and projects/layers/maps stay member-gated.
--
-- Breaking by design (the train posture): apps.sharing and the example
-- gallery stay, `apps.dataset_ids` stays (stats/charts/tables still read
-- the app's datasets), but the map widget's payload shape changes with no
-- back-compat, and `listExamples`-as-a-separate-surface dies with the
-- /apps explorer re-scope.

-- ---------------------------------------------------------------------------
-- §1 — apps.project_id + the per-creator ownership backfill
-- ---------------------------------------------------------------------------

alter table public.apps
  add column project_id uuid references public.projects on delete cascade;

-- The 0020 maps backfill, verbatim in shape: every pre-0022 app folds into
-- a per-creator project so the member-wide RLS below locks nobody out.
-- The claims GUCs are set PER ITERATION (the 0020 lesson): the projects
-- INSERT fires the 0009 stamp trigger + the 0018 birth trigger, and
-- auth.uid() is NULL in a migration session — the honest owner identity is
-- asserted for the statement so the stamp writes the true creator and the
-- birth trigger mints their owner membership. apps.created_by is NOT NULL
-- (0014), so there is no null-creator arm.
do $$
declare
  a record;
  pid uuid;
  v_owner uuid;
begin
  for a in
    select distinct on (created_by) created_by, id
    from public.apps
    where example is not true
    order by created_by, id
  loop
    v_owner := a.created_by;
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, false);
    perform set_config('request.jwt.claim.sub', v_owner::text, false);
    insert into public.projects (title, description, created_by)
    values (
      coalesce((select name from public.profiles where id = v_owner), 'Someone') || '''s apps',
      'Project holding the apps created before apps became project-owned (backfilled 2026-11-06).',
      v_owner
    )
    returning id into pid;
    update public.apps
      set project_id = pid
      where created_by = v_owner
        and example is not true
        and project_id is null;
  end loop;
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.jwt.claim.sub', '', false);
end
$$;

-- ---------------------------------------------------------------------------
-- §2 — app_versions (the append-only frozen publish chain)
-- ---------------------------------------------------------------------------

create table public.app_versions (
  id            uuid primary key default gen_random_uuid(),
  app_id        uuid not null references public.apps on delete cascade,
  version_label text not null,
  -- The frozen publish snapshot (the module comment's shape; shapeless jsonb
  -- like every stored spec — a typed check would fork from the feature's
  -- writer shape).
  definition    jsonb not null,
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now()
);
-- The version chain: an app's published history, newest first.
create index app_versions_by_app on public.app_versions (app_id, created_at desc);

create trigger app_versions_stamp_created_by before insert on public.app_versions
  for each row execute function public.stamp_created_by();

-- Reads ride the app's own visibility (the subquery runs as the reader, so
-- apps RLS — member-or-example — answers first). Freezing a version is a
-- content write (the app project's editor+); versions never mutate or
-- delete (append-only — no update/delete policies, the dataset_versions /
-- layer_versions posture).
alter table public.app_versions enable row level security;
create policy "app_versions select: the app's viewers"
  on public.app_versions for select to authenticated
  using (
    exists (select 1 from public.apps a where a.id = app_id)
  );
create policy "app_versions insert: the app project's editors"
  on public.app_versions for insert to authenticated
  with check (
    exists (
      select 1 from public.apps a
      where a.id = app_id and public.can_edit_project(a.project_id)
    )
  );

-- ---------------------------------------------------------------------------
-- §3 — the "System examples" project + the example chain + published examples
-- ---------------------------------------------------------------------------

-- Runs as the migration's admin connection; the claims GUCs attribute every
-- stamped row to the system identity (0014's seed posture, now through the
-- live stamp triggers). The birth trigger mints the system identity's owner
-- membership with the project. Re-apply guard: the project's fixed uuid.
do $seed$
declare
  v_system      uuid := public.system_examples_owner();
  v_project     uuid := 'e0000000-0000-4000-8000-000000000005'::uuid;
  v_map         uuid := 'e0000000-0000-4000-8000-000000000006'::uuid;
  v_parks       uuid := 'e0000000-0000-4000-8000-000000000001'::uuid;
  v_visits      uuid := 'e0000000-0000-4000-8000-000000000002'::uuid;
  v_explorer    uuid := 'e0000000-0000-4000-8000-000000000003'::uuid;
  v_atlas       uuid := 'e0000000-0000-4000-8000-000000000004'::uuid;
  v_parks_member uuid;
  v_visits_member uuid;
  v_parks_layer  uuid;
  v_parks_layer_member uuid;
  v_parks_dversion uuid;
  v_visits_dversion uuid;
  v_parks_ref    text;
  v_visits_ref   text;
  v_parks_layer_version uuid;
  v_dataset_pins jsonb;
  v_map_snapshots jsonb;
  v_layer_versions jsonb;
  v_definition   jsonb;
  rec            record;
  page           record;
  widget         record;
  v_new_pages    jsonb;
  v_new_widgets  jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_system)::text, false);
  perform set_config('request.jwt.claim.sub', v_system::text, false);

  if exists (select 1 from public.projects where id = v_project) then
    raise notice '0022: system examples project already seeded — seed block skipped';
    perform set_config('request.jwt.claims', '', false);
    perform set_config('request.jwt.claim.sub', '', false);
    return;
  end if;

  -- The project (the 0018 birth trigger mints the owner membership).
  insert into public.projects (id, title, description, created_by)
  values (
    v_project,
    'System examples',
    'The seeded example datasets, map and apps — read-only for everyone; make a copy to build on them.',
    v_system
  );

  -- The sample datasets join the project as OWNED memberships (they are the
  -- example workspace's data), so the parks layer can style them.
  insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode, added_by)
  values (v_project, v_parks::text, 'dataset', 'owned', 'manual', v_system)
  returning id into v_parks_member;
  insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode, added_by)
  values (v_project, v_visits::text, 'dataset', 'owned', 'manual', v_system)
  returning id into v_visits_member;

  -- The parks layer (data kind, default assigned-color style) + its OWNED
  -- layer membership (artifact_id = the layers row id — the layers-store
  -- create shape).
  insert into public.layers (project_id, kind, name, dataset_member_id)
  values (v_project, 'data', 'National parks (example)', v_parks_member)
  returning id into v_parks_layer;
  insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode, added_by)
  values (v_project, v_parks_layer::text, 'layer', 'owned', 'manual', v_system)
  returning id into v_parks_layer_member;

  -- The example map + its single placement (a map row — no inline-only mode).
  insert into public.maps (id, project_id, name, description, "order")
  values (v_map, v_project, 'National parks (example)',
          'The example map the seeded apps draw — parks as points on the base map.', 0);
  insert into public.map_layers (map_id, "order", layer_member_id, visible)
  values (v_map, 0, v_parks_layer_member, true);

  -- The sample datasets' published versions (freeze rows + inline geometry
  -- into version_entries) — the examples ship PUBLISHED, so their frozen
  -- widgets render from pins, and every signed-in viewer can read the
  -- frozen rows (the sample datasets are everyone-visible).
  v_parks_dversion := public.publish_version(v_parks, 'v1', 'seed-0014-parks-v1');
  v_visits_dversion := public.publish_version(v_visits, 'v1', 'seed-0014-visits-v1');
  select ref into v_parks_ref from public.dataset_versions where id = v_parks_dversion;
  select ref into v_visits_ref from public.dataset_versions where id = v_visits_dversion;

  -- The parks layer's published version (the definitionOf shape the layers
  -- store freezes; the dataset pin rides the stored {sourceMemberId,
  -- pinnedVersionId, pinnedRef} shape).
  insert into public.layer_versions (layer_id, version_label, definition, dataset)
  values (
    v_parks_layer,
    'v1',
    jsonb_build_object(
      'name', 'National parks (example)',
      'style', '{}'::jsonb,
      'filter', null, 'labels', null, 'popup', null,
      'opacity', null, 'visible', true),
    jsonb_build_object(
      'sourceMemberId', v_parks_member::text,
      'pinnedVersionId', v_parks_dversion::text,
      'pinnedRef', v_parks_ref)
  )
  returning id into v_parks_layer_version;

  -- The two example apps: into the project, map widgets carry mapId.
  update public.apps set project_id = v_project where id in (v_explorer, v_atlas);

  for rec in (
    select id, pages from public.apps where id in (v_explorer, v_atlas)
  ) loop
    v_new_pages := '[]'::jsonb;
    for page in (
      select e as page from jsonb_array_elements(rec.pages) e
    ) loop
      v_new_widgets := '[]'::jsonb;
      for widget in (
        select w as widget from jsonb_array_elements(page.page -> 'widgets') w
      ) loop
        if widget.widget ->> 'kind' = 'map' then
          widget.widget := jsonb_set(
            widget.widget - 'datasetIds',
            '{mapId}',
            to_jsonb(v_map::text)
          );
        end if;
        v_new_widgets := v_new_widgets || widget.widget;
      end loop;
      v_new_pages := v_new_pages || jsonb_set(page.page, '{widgets}', v_new_widgets);
    end loop;
    update public.apps set pages = v_new_pages where id = rec.id;
  end loop;

  -- The frozen publish snapshot's shared legs (identical for both apps).
  v_dataset_pins := jsonb_build_array(
    jsonb_build_object(
      'datasetId', v_parks::text, 'versionId', v_parks_dversion::text, 'ref', v_parks_ref,
      'title', (select title from public.datasets where id = v_parks),
      'jsonSchema', (select json_schema from public.datasets where id = v_parks),
      'isGeospatial', true, 'geometryType', 'Point',
      'bbox', (select bbox from public.datasets where id = v_parks)),
    jsonb_build_object(
      'datasetId', v_visits::text, 'versionId', v_visits_dversion::text, 'ref', v_visits_ref,
      'title', (select title from public.datasets where id = v_visits),
      'jsonSchema', (select json_schema from public.datasets where id = v_visits),
      'isGeospatial', false, 'geometryType', null,
      'bbox', null));
  v_map_snapshots := jsonb_build_array(
    jsonb_build_object(
      'mapId', v_map::text,
      'name', 'National parks (example)',
      'viewport', null, 'basemap', null,
      'placements', jsonb_build_array(
        jsonb_build_object('order', 0, 'visible', true, 'versionId', v_parks_layer_version::text))));
  v_layer_versions := jsonb_build_array(
    jsonb_build_object(
      'versionId', v_parks_layer_version::text,
      'layerId', v_parks_layer::text,
      'kind', 'data',
      'definition', jsonb_build_object(
        'name', 'National parks (example)',
        'style', '{}'::jsonb,
        'filter', null, 'labels', null, 'popup', null,
        'opacity', null, 'visible', true),
      'dataset', jsonb_build_object(
        'datasetId', v_parks::text,
        'versionId', v_parks_dversion::text,
        'ref', v_parks_ref),
      'frozenChildren', null));

  -- One PUBLISHED version per example app (the frozen snapshot its viewer
  -- renders; republishing is a new append-only row).
  for rec in (
    select id, title, description, pages from public.apps where id in (v_explorer, v_atlas)
  ) loop
    v_definition := jsonb_build_object(
      'title', rec.title,
      'description', rec.description,
      'pages', rec.pages,
      'datasetPins', v_dataset_pins,
      'mapSnapshots', v_map_snapshots,
      'layerVersions', v_layer_versions);
    insert into public.app_versions (app_id, version_label, definition)
    values (rec.id, 'v1', v_definition);
  end loop;

  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.jwt.claim.sub', '', false);
end
$seed$;

alter table public.apps alter column project_id set not null;
create index apps_by_project on public.apps (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- §4 — project_artifacts: kind domain widens to dataset|derived|layer|app;
-- one OWNED membership minted per existing app row (the apps store mints it
-- at create from now on — the layers-store pattern). The artifact_count
-- trigger stays exact for every writer.
-- ---------------------------------------------------------------------------

alter table public.project_artifacts drop constraint project_artifacts_artifact_kind_check;
alter table public.project_artifacts
  add constraint project_artifacts_artifact_kind_check
  check (artifact_kind in ('dataset','derived','layer','app'));

-- The mint cannot be one set-based INSERT: the 0009 stamp trigger overwrites
-- added_by with auth.uid() on EVERY row, and auth.uid() is NULL in a
-- migration session — the same GUC lesson the backfill and the seed teach.
-- One iteration per app, claims asserted from the app's creator.
do $$
declare
  a record;
begin
  for a in (select id, project_id, created_by from public.apps) loop
    perform set_config('request.jwt.claims', json_build_object('sub', a.created_by)::text, false);
    perform set_config('request.jwt.claim.sub', a.created_by::text, false);
    insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode, added_by)
    values (a.project_id, a.id::text, 'app', 'owned', 'manual', a.created_by)
    on conflict (project_id, artifact_kind, artifact_id) do nothing;
  end loop;
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.jwt.claim.sub', '', false);
end
$$;

-- ---------------------------------------------------------------------------
-- §5 — apps RLS: the 0014 creator-gate dies, the 0018 role split arrives.
-- Reads are member-wide with the ONE example arm (the seeded examples stay
-- readable by every signed-in viewer — what 0014's flat read granted,
-- narrowed to the flag); writes are project-editor+, never the examples,
-- never the system identity.
-- ---------------------------------------------------------------------------

drop policy if exists "apps select: authenticated" on public.apps;
drop policy if exists "apps insert: creator, never the system identity" on public.apps;
drop policy if exists "apps update: creator, never the system identity" on public.apps;
drop policy if exists "apps delete: creator, never the system identity" on public.apps;

create policy "apps select: project member or example"
  on public.apps for select to authenticated
  using (example is true or public.can_view_project(project_id));

create policy "apps insert: project editor"
  on public.apps for insert to authenticated
  with check (
    public.can_edit_project(project_id)
    and example is not true
    and created_by <> public.system_examples_owner()
  );

create policy "apps update: project editor"
  on public.apps for update to authenticated
  using (
    public.can_edit_project(project_id)
    and example is not true
    and created_by <> public.system_examples_owner()
  )
  with check (
    public.can_edit_project(project_id)
    and example is not true
    and created_by <> public.system_examples_owner()
  );

create policy "apps delete: project editor"
  on public.apps for delete to authenticated
  using (
    public.can_edit_project(project_id)
    and example is not true
    and created_by <> public.system_examples_owner()
  );

-- The 0014 column grants stand as written: project_id is deliberately NOT
-- in the UPDATE grant set (an app cannot move projects), and revision stays
-- client-writable (the CAS value).

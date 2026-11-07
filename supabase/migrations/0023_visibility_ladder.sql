-- Unified visibility ladder + publish closure preflight/promotion (issue
-- #260 — the project-centric train, phase 6;
-- docs/project-centric-experience-design.md §6, §7 D4; ADR 0022).
--
-- The model (D4 — the full ladder, no adoption steps):
--   * ONE vocabulary on every published artifact:
--       `members | signed-in | link | public`
--     where `members` = the project-membership gate ([project 1] tables),
--     `signed-in` = any authenticated user (ADR 0009's trusted-collaborator
--     posture, the default for published work), `link`/`public` = anon
--     gates written NOW (the serving paths are [project 7]'s). Widening =
--     moving up the ladder; the order is total.
--   * The fragments die: `datasets.published_visibility everyone|author`
--     becomes `datasets.visibility` (author → members, everyone →
--     signed-in — the in-migration mapping the train's handoff allows),
--     and `apps.sharing private|link` becomes `apps.visibility` (private →
--     members, link → signed-in — the old "link" meant anyone SIGNED IN
--     with the URL). `layers`, `maps` and `projects` gain the column at
--     `members` (exactly today's posture). All breaking, data disposable.
--   * Non-member read arms are PUBLISHED-scoped: a dataset's wider arm
--     requires lifecycle past draft (the ADR 0018 owned-draft clause stays
--     member-scoped), a layer's requires lifecycle = 'published' (a draft
--     layer is the working definition — project-visible only). Maps/apps
--     have no lifecycle column; their whole row is the shared artifact.
--   * Anon (`to anon`) SELECT gates land on the FROZEN rows only —
--     dataset_versions + version_entries, layer_versions, app_versions —
--     each gated on its parent artifact sitting at link/public. Live
--     tables get NO anon policies: [project 7] serves the published
--     viewer from frozen rows alone, never drafts, never live tables.
--   * The closure rule (§6.2, ArcGIS's lesson made automatic): sharing an
--     artifact at level L validates the whole reference closure — app →
--     its maps + datasets → each map's layers → each layer's dataset,
--     linked foreign pins INCLUDED (a foreign pinned member caps the
--     share; effective consumer access = min over the closure, P5). Two
--     SECURITY DEFINER RPCs:
--       visibility_preflight(kind, id, target) → the diff-style report:
--         every promotion (caller-editable members below the target) +
--         every blocker (a member below target the caller CANNOT edit —
--         never widened, never silent) + the effective level (min).
--       visibility_apply(kind, id, target)  → one transaction that widens
--         exactly the promotions preflight named (re-walked server-side,
--         per-member can_edit gates re-checked as the definer), leaves
--         blockers untouched, and returns what it did. Widening only —
--         narrowing rides the plain RLS'd column update. The root itself
--         is a closure member, so the confirm widens it too.
--     Both refuse for a caller who cannot edit the root artifact.
--   * The bundle press learns the ladder: `publish_bundles.visibility` is
--     the press's target level, and `publish_bundle_members`
--     visibility_from/visibility_to record the promotion plan per member
--     (stamped at mint; the press applies it through visibility_apply
--     after the freeze legs).

-- ---------------------------------------------------------------------------
-- §1 — datasets: the ladder column replaces published_visibility
-- ---------------------------------------------------------------------------

alter table public.datasets add column visibility text;

-- The in-migration mapping (the one backfill the train posture allows):
-- 'author' datasets narrow to `members` (creator + owning-project members —
-- the honest reading of author-only), 'everyone' widens nowhere (it meant
-- any signed-in user) and lands at `signed-in`.
update public.datasets
  set visibility = case published_visibility when 'author' then 'members' else 'signed-in' end;

alter table public.datasets
  alter column visibility set default 'signed-in',
  alter column visibility set not null;
alter table public.datasets
  add constraint datasets_visibility_check
  check (visibility in ('members','signed-in','link','public'));

-- The `members`-rung gate for PUBLISHED datasets, under its honest name,
-- created BEFORE the gate re-issue below references it (an SQL function
-- body is validated against the live schema at CREATE time): ANY project
-- holds the dataset as an OWNED artifact and the reader is one of its
-- members (any role). Same body as project_holds_owned_draft — the draft
-- clause and the published `members` rung share one membership walk; two
-- names keep the two call sites' intent legible.
create function public.project_holds_owned_artifact(p_dataset uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1
    from public.project_artifacts pa
    join public.project_members pm on pm.project_id = pa.project_id
    where pa.artifact_kind = 'dataset'
      and pa.artifact_id = p_dataset::text
      and pa.role = 'owned'
      and pm.user_id = p_user
  )
$$;

-- The gate re-issue must precede the column drop (an SQL function body is
-- validated against the live schema at CREATE time, and the OLD body
-- references published_visibility). The three reader arms keep their
-- shapes; the published arm's ladder predicate replaces the author check:
--   creator           — everything their row allows, as before;
--   published-visible — lifecycle past draft AND (visibility past
--                       `members` OR the reader is a member of a project
--                       holding the dataset as an OWNED artifact — the
--                       `members` rung is the [project 1] membership gate);
--   owned-draft       — the ADR 0018 clause, unchanged and still
--                       DRAFT-scoped: project sharing never widens a row
--                       past its draft; the ladder owns published rows.
create or replace function public.can_view_dataset(p_dataset uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset
      and auth.uid() is not null
      and (
        d.created_by = auth.uid()
        or (
          d.lifecycle is distinct from 'draft'
          and (
            d.visibility is distinct from 'members'
            or public.project_holds_owned_artifact(d.id, auth.uid())
          )
        )
        or (d.lifecycle = 'draft' and public.project_holds_owned_draft(d.id, auth.uid()))
      )
  );
$$;

-- Now the drop is clean: the replaced function no longer references the
-- old column, and the by-lifecycle index (which included it) dies with it.
alter table public.datasets drop column published_visibility;
create index datasets_by_lifecycle on public.datasets (lifecycle, visibility, created_at desc);

-- The 0003 client-writable column set, re-granted with the swap (grants
-- are additive — the old column must be revoked out, not merely omitted).
-- `group_id` rides along: 0007 granted it additively AFTER the 0003 list,
-- and this migration's revoke would otherwise strip it back off.
revoke update on public.datasets from authenticated;
grant update (title, description, json_schema, properties,
              is_geospatial, geometry_type, simplify_geometry,
              edit_policy, visibility, lifecycle,
              source_file_name, source_file_size, source_file_path,
              group_id)
  on public.datasets to authenticated;

-- ---------------------------------------------------------------------------
-- §2 — layers & maps: the ladder column + the widened read arms
-- ---------------------------------------------------------------------------

alter table public.layers
  add column visibility text not null default 'members'
    check (visibility in ('members','signed-in','link','public'));
alter table public.maps
  add column visibility text not null default 'members'
    check (visibility in ('members','signed-in','link','public'));

-- A DRAFT layer is the working definition — project-visible only (the
-- 0020 posture). The wider arms require a PUBLISHED layer: the frozen
-- chain exists, and sharing it is sharing the published definition.
drop policy "layers select: project member" on public.layers;
create policy "layers select: project member or wider"
  on public.layers for select to authenticated
  using (
    public.can_view_project(project_id)
    or (
      auth.uid() is not null
      and lifecycle = 'published'
      and visibility in ('signed-in','link','public')
    )
  );

-- Versions ride their layer's viewership (the 0020 subquery posture, plus
-- the same wider arm).
drop policy "layer_versions select: layer project member" on public.layer_versions;
create policy "layer_versions select: the layer's viewers"
  on public.layer_versions for select to authenticated
  using (
    exists (
      select 1 from public.layers l
      where l.id = layer_id
        and (
          public.can_view_project(l.project_id)
          or (
            auth.uid() is not null
            and l.lifecycle = 'published'
            and l.visibility in ('signed-in','link','public')
          )
        )
    )
  );

-- Maps have no lifecycle column — the row IS the shared artifact; the
-- `members` default keeps today's posture and widening is the editor's
-- explicit act (the preflight confirms the closure first).
drop policy "maps select: project member" on public.maps;
create policy "maps select: project member or wider"
  on public.maps for select to authenticated
  using (
    public.can_view_project(project_id)
    or (
      auth.uid() is not null
      and visibility in ('signed-in','link','public')
    )
  );

-- Placements ride their map's viewership, so a widened map's layer list
-- reads for the wider audience too (the layer rows themselves stay gated
-- by the layers policy above).
drop policy "map_layers select: map project member" on public.map_layers;
create policy "map_layers select: the map's viewers"
  on public.map_layers for select to authenticated
  using (
    exists (
      select 1 from public.maps m
      where m.id = map_id
        and (
          public.can_view_project(m.project_id)
          or (
            auth.uid() is not null
            and m.visibility in ('signed-in','link','public')
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- §3 — apps: the ladder column replaces sharing
-- ---------------------------------------------------------------------------

alter table public.apps add column visibility text;

-- private → members (the creator/project posture), link → signed-in (the
-- old "link" granted any SIGNED-IN user with the URL; the anon rung is
-- new and never silently granted).
update public.apps
  set visibility = case sharing when 'private' then 'members' else 'signed-in' end;

alter table public.apps
  alter column visibility set default 'members',
  alter column visibility set not null;
alter table public.apps
  add constraint apps_visibility_check
  check (visibility in ('members','signed-in','link','public'));

alter table public.apps drop column sharing;

revoke update on public.apps from authenticated;
grant update (title, description, visibility, dataset_ids, pages, revision, updated_at)
  on public.apps to authenticated;

-- The select policy gains the wider arm beside the 0022 example arm; the
-- write policies stand (project-editor+, never the examples).
drop policy "apps select: project member or example" on public.apps;
create policy "apps select: project member, example, or wider"
  on public.apps for select to authenticated
  using (
    example is true
    or public.can_view_project(project_id)
    or (
      auth.uid() is not null
      and visibility in ('signed-in','link','public')
    )
  );

-- ---------------------------------------------------------------------------
-- §4 — projects: the ladder column (the project row itself is an artifact)
-- ---------------------------------------------------------------------------

alter table public.projects
  add column visibility text not null default 'members'
    check (visibility in ('members','signed-in','link','public'));

-- Widening the project row shares its title/description/chips — never its
-- artifacts (each rides its own rung). Owner-only by the 0018 UPDATE
-- policy (can_manage_project); the grant joins the client-writable set.
revoke update on public.projects from authenticated;
grant update (title, description, visibility) on public.projects to authenticated;

drop policy "projects select: member or creator" on public.projects;
create policy "projects select: member, creator, or wider"
  on public.projects for select to authenticated
  using (
    created_by = auth.uid()
    or public.can_view_project(id)
    or (
      auth.uid() is not null
      and visibility in ('signed-in','link','public')
    )
  );

-- The seeded examples project is the public gallery: every signed-in
-- viewer already reads its example apps; the project row now says so.
update public.projects
  set visibility = 'signed-in'
  where id = 'e0000000-0000-4000-8000-000000000005'::uuid;

-- ---------------------------------------------------------------------------
-- §5 — anon gates: FROZEN rows only, at link/public ([project 7] serves
-- from exactly these; live tables stay closed to anon — never drafts,
-- never live data, no service-role shortcuts).
--
-- The parent checks live in SECURITY DEFINER helpers, NOT policy
-- subqueries: expressions inside a policy are evaluated under the
-- invoking role, and the live tables carry no anon policies — an inline
-- `exists (select … from datasets …)` in a `to anon` policy would read
-- zero rows and the gate would be vacuously closed forever (the same
-- reason the 0003 helpers are definer functions).
-- ---------------------------------------------------------------------------

create function public.published_dataset_anon_visible(p_dataset uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset
      and d.lifecycle is distinct from 'draft'
      and d.visibility in ('link','public')
  )
$$;

create function public.published_layer_anon_visible(p_layer uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.layers l
    where l.id = p_layer
      and l.lifecycle = 'published'
      and l.visibility in ('link','public')
  )
$$;

create function public.published_app_anon_visible(p_app uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.apps a
    where a.id = p_app
      and a.visibility in ('link','public')
  )
$$;

create policy "dataset_versions select: anon on link/public frozen rows"
  on public.dataset_versions for select to anon
  using (public.published_dataset_anon_visible(dataset_id));

create policy "version_entries select: anon via the version's dataset"
  on public.version_entries for select to anon
  using (
    exists (
      select 1 from public.dataset_versions dv
      where dv.id = version_id
        and public.published_dataset_anon_visible(dv.dataset_id)
    )
  );

create policy "layer_versions select: anon on link/public frozen rows"
  on public.layer_versions for select to anon
  using (public.published_layer_anon_visible(layer_id));

create policy "app_versions select: anon on link/public frozen rows"
  on public.app_versions for select to anon
  using (public.published_app_anon_visible(app_id));

-- ---------------------------------------------------------------------------
-- §6 — the closure preflight/promotion engine (§6.2: the bundle press
-- becomes this preflight + promotion engine; it already walks versions —
-- it must learn to walk it for VISIBILITY).
-- ---------------------------------------------------------------------------

-- The ladder's total order (null on an unknown level — every caller
-- treats null as "refuse").
create function public.visibility_ladder_rank(p_level text)
returns integer
language sql immutable
set search_path = public, extensions as $$
  select case p_level
    when 'members' then 0
    when 'signed-in' then 1
    when 'link' then 2
    when 'public' then 3
  end
$$;

-- The reference closure of one artifact, INCLUDING the root: every member
-- the artifact renders, with its home project (null for datasets), name
-- and current rung. Linked foreign pins are members by design — they cap
-- the share (P5: effective consumer access = min over the closure).
-- SECURITY DEFINER so the walk reads memberships/versions the caller
-- cannot name row-by-row; the REPORT names what the caller's artifact
-- already embeds. STABLE (read-only). Cycles are cut by the seen-set.
create function public.visibility_closure(p_kind text, p_artifact_id text)
returns table (
  member_kind       text,
  member_id         text,
  member_project    uuid,
  member_name       text,
  member_visibility text
)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_queue   text[] := array[p_kind || ':' || p_artifact_id];
  v_seen    text[] := array[]::text[];
  v_entry   text;
  v_kind    text;
  v_id      text;
  v_name    text;
  v_vis     text;
  v_proj    uuid;
  v_lkind   text;
  v_member  uuid;
  v_lid     uuid;
  v_aid     text;
  v_pages   jsonb;
  v_page    record;
  v_widget  record;
  v_child   record;
  v_datasets text[];
  v_ds      text;
begin
  if p_kind not in ('dataset','layer','map','app','project') then
    raise exception 'visibility_closure: unknown artifact kind %', p_kind;
  end if;

  while coalesce(array_length(v_queue, 1), 0) > 0 loop
    v_entry := v_queue[1];
    v_queue := v_queue[2:coalesce(array_length(v_queue, 1), 1)];
    v_kind := split_part(v_entry, ':', 1);
    v_id   := substr(v_entry, strpos(v_entry, ':') + 1);
    if v_kind || ':' || v_id = any(v_seen) then
      continue;
    end if;
    v_seen := v_seen || (v_kind || ':' || v_id);

    if v_kind = 'dataset' then
      -- Terminal member (derived registry rows carry no rung — their
      -- publishing legs are not landed; they stay out of the ladder).
      select d.title, d.visibility
        into v_name, v_vis
        from public.datasets d where d.id = v_id::uuid;
      if found then
        return query select 'dataset', v_id, null::uuid, v_name, v_vis;
      end if;

    elsif v_kind = 'layer' then
      select l.name, l.visibility, l.project_id, l.kind, l.dataset_member_id
        into v_name, v_vis, v_proj, v_lkind, v_member
        from public.layers l where l.id = v_id::uuid;
      if found then
        return query select 'layer', v_id, v_proj, v_name, v_vis;
        if v_lkind = 'data' and v_member is not null then
          -- The layer styles a dataset MEMBERSHIP of its project; only a
          -- dataset membership carries a rung.
          select pa.artifact_id into v_aid
            from public.project_artifacts pa
            where pa.id = v_member and pa.artifact_kind = 'dataset';
          if found then
            v_queue := v_queue || ('dataset:' || v_aid);
          end if;
        elsif v_lkind = 'group' then
          -- Owned children are layers of the same project; linked children
          -- are PINNED layer_versions rows (resolve the owning layer).
          for v_child in
            select lc.child_kind, lc.child_layer_id
              from public.layer_children lc where lc.group_id = v_id::uuid
          loop
            if v_child.child_kind = 'owned' then
              v_queue := v_queue || ('layer:' || v_child.child_layer_id::text);
            else
              select lv.layer_id into v_lid
                from public.layer_versions lv where lv.id = v_child.child_layer_id;
              if found then
                v_queue := v_queue || ('layer:' || v_lid::text);
              end if;
            end if;
          end loop;
        end if;
      end if;

    elsif v_kind = 'map' then
      select m.name, m.visibility, m.project_id
        into v_name, v_vis, v_proj
        from public.maps m where m.id = v_id::uuid;
      if found then
        return query select 'map', v_id, v_proj, v_name, v_vis;
        -- Placements reference layer MEMBERSHIPS: owned memberships point
        -- at a layers row, linked ones at their pinned layer_versions row.
        for v_child in
          select pa.role, pa.artifact_id
            from public.map_layers ml
            join public.project_artifacts pa on pa.id = ml.layer_member_id
            where ml.map_id = v_id::uuid
        loop
          if v_child.role = 'owned' then
            v_queue := v_queue || ('layer:' || v_child.artifact_id);
          else
            select lv.layer_id into v_lid
              from public.layer_versions lv where lv.id = v_child.artifact_id::uuid;
            if found then
              v_queue := v_queue || ('layer:' || v_lid::text);
            end if;
          end if;
        end loop;
      end if;

    elsif v_kind = 'app' then
      select a.title, a.visibility, a.project_id, a.pages, a.dataset_ids
        into v_name, v_vis, v_proj, v_pages, v_datasets
        from public.apps a where a.id = v_id::uuid;
      if found then
        return query select 'app', v_id, v_proj, v_name, v_vis;
        for v_page in select e as page from jsonb_array_elements(v_pages) e loop
          for v_widget in select w as widget from jsonb_array_elements(v_page.page -> 'widgets') w loop
            if v_widget.widget ->> 'kind' = 'map' and v_widget.widget ->> 'mapId' is not null then
              v_queue := v_queue || ('map:' || (v_widget.widget ->> 'mapId'));
            end if;
          end loop;
        end loop;
        foreach v_ds in array v_datasets loop
          v_queue := v_queue || ('dataset:' || v_ds);
        end loop;
      end if;

    elsif v_kind = 'project' then
      select p.title, p.visibility, p.id
        into v_name, v_vis, v_proj
        from public.projects p where p.id = v_id::uuid;
      if found then
        return query select 'project', v_id, v_proj, v_name, v_vis;
        -- Owned AND linked memberships are members (a linked pin renders
        -- through the project's artifacts — its home rung caps the share).
        for v_child in
          select pa.artifact_kind, pa.role, pa.artifact_id
            from public.project_artifacts pa
            where pa.project_id = v_id::uuid
              and pa.artifact_kind in ('dataset','layer','app')
        loop
          if v_child.artifact_kind = 'dataset' then
            v_queue := v_queue || ('dataset:' || v_child.artifact_id);
          elsif v_child.artifact_kind = 'app' then
            v_queue := v_queue || ('app:' || v_child.artifact_id);
          elsif v_child.role = 'owned' then
            v_queue := v_queue || ('layer:' || v_child.artifact_id);
          else
            select lv.layer_id into v_lid
              from public.layer_versions lv where lv.id = v_child.artifact_id::uuid;
            if found then
              v_queue := v_queue || ('layer:' || v_lid::text);
            end if;
          end if;
        end loop;
        for v_child in select m.id from public.maps m where m.project_id = v_id::uuid loop
          v_queue := v_queue || ('map:' || v_child.id::text);
        end loop;
      end if;
    end if;
  end loop;
end
$$;

-- The per-member edit gate (the apply's write authorization): the caller
-- must hold the artifact's OWN edit right — a dataset's can_edit_dataset,
-- a project-owned artifact's can_edit_project, a project's owner gate.
create function public.visibility_member_editable(p_kind text, p_project uuid, p_id text)
returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_kind = 'dataset' then
    return public.can_edit_dataset(p_id::uuid);
  elsif p_kind = 'project' then
    return p_project is not null and public.can_manage_project(p_project);
  elsif p_kind in ('layer','map','app') then
    return p_project is not null and public.can_edit_project(p_project);
  end if;
  return false;
end
$$;

-- The diff-style report (§6.2): "sharing publicly also widens 2 datasets
-- and 1 map — review". Widening-only: a target at or below the root's
-- current rung answers an empty plan (narrowing rides the plain column
-- update, no closure to validate). Blockers are named, never widened.
create function public.visibility_preflight(p_kind text, p_artifact_id text, p_target text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_target_rank integer := public.visibility_ladder_rank(p_target);
  v_vis         text;
  v_proj        uuid;
  v_member      record;
  v_promotions  jsonb := '[]'::jsonb;
  v_blockers    jsonb := '[]'::jsonb;
  v_effective   integer;
begin
  if v_target_rank is null then
    raise exception 'visibility_preflight: unknown visibility level %', p_target;
  end if;
  if p_kind not in ('dataset','layer','map','app','project') then
    raise exception 'visibility_preflight: unknown artifact kind %', p_kind;
  end if;

  -- The root's own row: its current rung and home project (datasets are
  -- global — no home project; a project is its own).
  if p_kind = 'dataset' then
    select visibility into v_vis from public.datasets where id = p_artifact_id::uuid;
  elsif p_kind = 'layer' then
    select visibility, project_id into v_vis, v_proj from public.layers where id = p_artifact_id::uuid;
  elsif p_kind = 'map' then
    select visibility, project_id into v_vis, v_proj from public.maps where id = p_artifact_id::uuid;
  elsif p_kind = 'app' then
    select visibility, project_id into v_vis, v_proj from public.apps where id = p_artifact_id::uuid;
  else
    select visibility, id into v_vis, v_proj from public.projects where id = p_artifact_id::uuid;
  end if;
  if v_vis is null then
    raise exception 'visibility_preflight: no such % artifact', p_kind;
  end if;

  -- The widening actor must hold the ROOT's edit right.
  if not public.visibility_member_editable(p_kind, v_proj, p_artifact_id) then
    raise exception 'visibility_preflight: the caller cannot edit this artifact';
  end if;

  -- Below the target there is nothing to promote (widening-only RPCs).
  if public.visibility_ladder_rank(v_vis) >= v_target_rank then
    return jsonb_build_object(
      'target', p_target,
      'effective', v_vis,
      'promotions', '[]'::jsonb,
      'blockers', '[]'::jsonb);
  end if;

  v_effective := v_target_rank;
  for v_member in
    select * from public.visibility_closure(p_kind, p_artifact_id)
  loop
    continue when public.visibility_ladder_rank(v_member.member_visibility) >= v_target_rank;
    if public.visibility_member_editable(v_member.member_kind, v_member.member_project, v_member.member_id) then
      v_promotions := v_promotions || jsonb_build_object(
        'kind', v_member.member_kind,
        'id', v_member.member_id,
        'name', v_member.member_name,
        'from', v_member.member_visibility,
        'to', p_target);
    else
      v_blockers := v_blockers || jsonb_build_object(
        'kind', v_member.member_kind,
        'id', v_member.member_id,
        'name', v_member.member_name,
        'current', v_member.member_visibility,
        'projectId', v_member.member_project);
      v_effective := least(v_effective, public.visibility_ladder_rank(v_member.member_visibility));
    end if;
  end loop;

  return jsonb_build_object(
    'target', p_target,
    'effective', case v_effective
      when 0 then 'members' when 1 then 'signed-in' when 2 then 'link' when 3 then 'public' end,
    'promotions', v_promotions,
    'blockers', v_blockers);
end
$$;

-- The confirmed apply: ONE transaction that widens exactly the promotions
-- the preflight named — re-walked server-side (the client never supplies
-- the plan), each member's edit right re-checked as the definer, blockers
-- left untouched and returned. Never widens without the caller's own edit
-- right; never touches a member below the target it cannot edit.
create function public.visibility_apply(p_kind text, p_artifact_id text, p_target text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_target_rank integer := public.visibility_ladder_rank(p_target);
  v_vis         text;
  v_proj        uuid;
  v_member      record;
  v_applied     jsonb := '[]'::jsonb;
  v_blockers    jsonb := '[]'::jsonb;
  v_effective   integer;
begin
  if v_target_rank is null then
    raise exception 'visibility_apply: unknown visibility level %', p_target;
  end if;
  if p_kind not in ('dataset','layer','map','app','project') then
    raise exception 'visibility_apply: unknown artifact kind %', p_kind;
  end if;

  -- Same root resolution + gate as the preflight (the two RPCs answer
  -- identical denials, so a report and its confirm cannot disagree).
  if p_kind = 'dataset' then
    select visibility into v_vis from public.datasets where id = p_artifact_id::uuid;
  elsif p_kind = 'layer' then
    select visibility, project_id into v_vis, v_proj from public.layers where id = p_artifact_id::uuid;
  elsif p_kind = 'map' then
    select visibility, project_id into v_vis, v_proj from public.maps where id = p_artifact_id::uuid;
  elsif p_kind = 'app' then
    select visibility, project_id into v_vis, v_proj from public.apps where id = p_artifact_id::uuid;
  else
    select visibility, id into v_vis, v_proj from public.projects where id = p_artifact_id::uuid;
  end if;
  if v_vis is null then
    raise exception 'visibility_apply: no such % artifact', p_kind;
  end if;
  if not public.visibility_member_editable(p_kind, v_proj, p_artifact_id) then
    raise exception 'visibility_apply: the caller cannot edit this artifact';
  end if;

  -- Widening-only: a target at or below the root's current rung is a
  -- no-op (narrowing rides the plain RLS'd column update).
  if public.visibility_ladder_rank(v_vis) >= v_target_rank then
    return jsonb_build_object(
      'target', p_target,
      'effective', v_vis,
      'applied', '[]'::jsonb,
      'blockers', '[]'::jsonb);
  end if;

  v_effective := v_target_rank;
  for v_member in
    select * from public.visibility_closure(p_kind, p_artifact_id)
  loop
    continue when public.visibility_ladder_rank(v_member.member_visibility) >= v_target_rank;
    if public.visibility_member_editable(v_member.member_kind, v_member.member_project, v_member.member_id) then
      case v_member.member_kind
        when 'dataset' then
          update public.datasets set visibility = p_target where id = v_member.member_id::uuid;
        when 'layer' then
          update public.layers set visibility = p_target where id = v_member.member_id::uuid;
        when 'map' then
          update public.maps set visibility = p_target where id = v_member.member_id::uuid;
        when 'app' then
          update public.apps set visibility = p_target where id = v_member.member_id::uuid;
        when 'project' then
          update public.projects set visibility = p_target where id = v_member.member_id::uuid;
      end case;
      v_applied := v_applied || jsonb_build_object(
        'kind', v_member.member_kind,
        'id', v_member.member_id,
        'name', v_member.member_name,
        'from', v_member.member_visibility,
        'to', p_target);
    else
      v_blockers := v_blockers || jsonb_build_object(
        'kind', v_member.member_kind,
        'id', v_member.member_id,
        'name', v_member.member_name,
        'current', v_member.member_visibility,
        'projectId', v_member.member_project);
      v_effective := least(v_effective, public.visibility_ladder_rank(v_member.member_visibility));
    end if;
  end loop;

  return jsonb_build_object(
    'target', p_target,
    'effective', case v_effective
      when 0 then 'members' when 1 then 'signed-in' when 2 then 'link' when 3 then 'public' end,
    'applied', v_applied,
    'blockers', v_blockers);
end
$$;

revoke all on function public.visibility_preflight(text, text, text) from anon, public;
revoke all on function public.visibility_apply(text, text, text) from anon, public;
grant execute on function public.visibility_preflight(text, text, text) to authenticated;
grant execute on function public.visibility_apply(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- §7 — the bundle press learns the ladder: the press's target rung on the
-- bundle row, the per-member promotion plan on the member rows (stamped at
-- mint from the confirmed preflight; the press applies it through
-- visibility_apply after the freeze legs).
-- ---------------------------------------------------------------------------

alter table public.publish_bundles
  add column visibility text not null default 'signed-in'
    check (visibility in ('members','signed-in','link','public'));

alter table public.publish_bundle_members
  add column visibility_from text,
  add column visibility_to text;

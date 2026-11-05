-- Project membership & roles (issue #255 — the project-centric train, phase 1;
-- docs/project-centric-experience-design.md §4.4 membership row, §7 D1/D4;
-- ADR 0017, which re-issues the preserved Convex-era branch's ADR 0011
-- `project-collaboration` for the Postgres backend).
--
-- Projects stop being per-creator PRIVATE (the 0009 stage-8 exception) and
-- become collaborative workspaces: `project_members (project_id, user_id,
-- role owner|editor|viewer)` gates every project-held table. The role matrix
-- (ADR 0017; the issue's recorded decisions):
--   * owner  — everything, plus member management (invite/role/remove) and
--     project deletion; also the project's settings writes (title/
--     description). The issue's matrix puts "edit settings" at owner level —
--     a deliberate deviation from the Convex-era ADR 0011, which had
--     `projects.update` at editor level; the issue is the train's contract.
--   * editor — every content write on project-held work: artifact
--     memberships (add/remove references), their fork consumer edges, and
--     the bundle press (publish_bundles/members rows).
--   * viewer — read the workspace; never write.
--   * outsider (non-member) — the no-existence-leak posture stands: a
--     foreign project reads as not-found and its writes answer 0 rows /
--     RLS refusals exactly as before. Nobody sees a 403; the UI renders the
--     not-found card.
--
-- Breaking by design (the train's no-back-compat posture): the four 0009
-- creator-only policies are DROPPED and rewritten here, and the two
-- owner-rule helpers they used are re-issued membership-aware under the
-- same names (their only consumers are the policies this file rewrites;
-- `consumer_reference_owner` keeps its name because consumer_references'
-- policies reference it and are NOT otherwise touched).
--
-- Deliberately OUT of scope (recorded on the issue + ADR): dataset-table RLS
-- is unchanged — project-held DRAFT member-visibility (ADR 0011's "adding a
-- draft to a project IS sharing") lands with #256's create/import-inside-
-- project flow, the first flow that can put a draft into a project.

-- ---------------------------------------------------------------------------
-- §1 — project_members (the whole grant is the row; ADR 0011's shape, PG
-- edition). One role per (project, user); `added_by` is attribution (the
-- inviter — the 0009 project_artifacts pattern), not a permission.
-- ---------------------------------------------------------------------------

create table public.project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null check (role in ('owner','editor','viewer')),
  added_by   uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);
-- The issue's `by_project`/`by_user` names, kept verbatim.
create index project_members_by_project on public.project_members (project_id);
create index project_members_by_user on public.project_members (user_id);

-- The inviter is stamped from the request, never claimed from a payload
-- (the 0009 project_artifacts_stamp_added_by pattern) — but only when a
-- request identity exists: the migration/admin paths have auth.uid() null
-- and the column NOT NULL, so they must carry an explicit added_by to land
-- at all (this migration's own backfill below is exactly such a writer,
-- and the live-stack apply caught the unguarded stamp refusing it).
create function public.project_members_stamp_added_by() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is not null then
    new.added_by := auth.uid();
  end if;
  return new;
end $$;

create trigger project_members_stamp_added_by before insert on public.project_members
  for each row execute function public.project_members_stamp_added_by();

-- The creator's owner row is born WITH the project — for EVERY writer
-- (client, migration, direct SQL), so "a project always has an owner" is an
-- invariant, not a store-side convention (the 0009 artifact_count lockstep
-- posture: enforce at the database). AFTER INSERT, not BEFORE: the FK on
-- project_members.project_id needs the projects row to exist. SECURITY
-- DEFINER: the insert cannot wait for RLS on project_members to admit it
-- (a WITH CHECK asking "is the inviter already an owner?" would be circular
-- on the very first row). AFTER row triggers run before RETURNING is
-- evaluated and before the INSERT..RETURNING SELECT policy — so the
-- store's `.select("id").single()` create path finds the membership its
-- SELECT policy needs already in place (the 0008 lesson's forward edge).
create function public.project_members_birth_owner() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (project_id, user_id) do nothing;
  return null;
end $$;

create trigger project_members_birth_owner after insert on public.projects
  for each row execute function public.project_members_birth_owner();

-- The creator's owner row is PERMANENT (ADR 0011: setRole/removeMember
-- refuse to touch it) — that one carve-out keeps "always has an owner" true
-- with no last-owner election logic. Ownership transfer is future work and
-- would need a different mechanism precisely because this row cannot move.
create function public.project_members_guard_creator_owner() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  -- Cascades pass untouched (the 0009 tags_guard_retire depth rule): the
  -- project delete walking its members — and an auth.users deletion walking
  -- profiles→members — legitimately removes the creator's row with its
  -- container; only DIRECT member-management paths are gated, or no project
  -- could ever be deleted.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if old.role = 'owner' and old.user_id = (
    select p.created_by from public.projects p where p.id = old.project_id
  ) then
    raise exception 'The project creator''s owner membership is permanent — a project always has an owner.';
  end if;
  return coalesce(new, old);
end $$;

create trigger project_members_guard_creator_owner_update before update on public.project_members
  for each row execute function public.project_members_guard_creator_owner();
create trigger project_members_guard_creator_owner_delete before delete on public.project_members
  for each row execute function public.project_members_guard_creator_owner();

-- Backfill: every project that exists before this migration gets its
-- creator's owner row (the one in-migration backfill the train's handoff
-- posture allows — without it the RLS rewrite below would lock every
-- existing project out, creator included).
insert into public.project_members (project_id, user_id, role, added_by)
select p.id, p.created_by, 'owner', p.created_by
from public.projects p
on conflict (project_id, user_id) do nothing;

-- ---------------------------------------------------------------------------
-- §2 — the role helpers. Two families, the 0008/0009 split kept exactly:
--   * DEFINER + stable (`project_member_role`): reads project_members for
--     policies ON project_members itself — invoker would recurse (the
--     0003 can_view_dataset reason), and INSERT..RETURNING evaluates the
--     SELECT policy on the new row (the 0008 lesson).
--   * INVOKER + stable (can_*_project, the rewritten owner-rule helpers):
--     read OTHER tables relative to every policy that calls them — no
--     recursion, no just-inserted-row blind spot.
-- ---------------------------------------------------------------------------

create function public.project_member_role(p_project uuid, p_user uuid)
returns text
language sql stable security definer set search_path = public, extensions as $$
  select pm.role
  from public.project_members pm
  where pm.project_id = p_project and pm.user_id = p_user
$$;

create function public.can_view_project(p_project uuid) returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select auth.uid() is not null and public.project_member_role(p_project, auth.uid()) is not null
$$;

create function public.can_edit_project(p_project uuid) returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select public.project_member_role(p_project, auth.uid()) in ('owner','editor')
$$;

create function public.can_manage_project(p_project uuid) returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select public.project_member_role(p_project, auth.uid()) = 'owner'
$$;

-- ---------------------------------------------------------------------------
-- §3 — the owner-rule helpers, re-issued membership-aware (same names; the
-- policies below are their only consumers and are rewritten in the same
-- file). project_artifact_owner/publish_bundle_owner now answer the EDITOR
-- arm (owner > editor, the total order's "at least" check); reads get their
-- own viewable helpers (a viewer reads bundles, never presses them).
-- ---------------------------------------------------------------------------

create or replace function public.project_artifact_owner(p_project uuid)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select public.can_edit_project(p_project)
$$;

create or replace function public.publish_bundle_viewable(p_bundle uuid)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select exists (
    select 1
    from public.publish_bundles b
    join public.project_members pm on pm.project_id = b.project_id
    where b.id = p_bundle and pm.user_id = auth.uid()
  )
$$;

create or replace function public.publish_bundle_owner(p_bundle uuid)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select exists (
    select 1
    from public.publish_bundles b
    join public.project_members pm on pm.project_id = b.project_id
    where b.id = p_bundle
      and pm.user_id = auth.uid()
      and pm.role in ('owner','editor')
  )
$$;

-- consumer_references' policies (0009) keep referencing this helper by
-- name — only its body changes: a fork edge belongs to the membership's
-- project's OWNER|EDITOR members now (was: the project's creator). Map
-- edges stay the shared-catalog exception; derived edges stay their
-- registry row's creator.
create or replace function public.consumer_reference_owner(p_kind text, p_consumer text)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select p_kind = 'map'
    or exists (
    select 1
    from public.project_artifacts pa
    join public.project_members pm on pm.project_id = pa.project_id
    where pa.id::text = p_consumer
      and pm.user_id = auth.uid()
      and pm.role in ('owner','editor')
  )
  or exists (
    select 1 from public.derived_datasets dd
    where dd.id::text = p_consumer and dd.created_by = auth.uid()
  )
$$;

-- ---------------------------------------------------------------------------
-- §4 — project_invite_resolve (the definer RPC the email column-grant
-- requires). 0002 keeps `profiles.email` server-side (authenticated has NO
-- select grant on the column — the ADR 0009 addendum PII line), so
-- invite-by-email cannot be a client-side lookup. This definer resolves one
-- exact email to a profile id and nothing else: no column leak, no
-- enumeration to non-managers (the gate restated for the definer, the
-- 0005/0009 publish_version pattern). Unknown emails answer null — the
-- store surfaces "no account with that email"; a non-manager caller
-- raises (the honest denial — the UI only shows the invite control to
-- owners, so a raise here means a crafted call).
-- ---------------------------------------------------------------------------

create function public.project_invite_resolve(p_project uuid, p_email text)
returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_user uuid;
begin
  if public.project_member_role(p_project, auth.uid()) is distinct from 'owner' then
    raise exception 'project_invite_resolve: caller does not manage this project';
  end if;
  if p_email is null then
    return null;
  end if;
  select p.id into v_user
  from public.profiles p
  where lower(p.email) = lower(btrim(p_email))
  limit 1;
  return v_user;
end $$;

-- ---------------------------------------------------------------------------
-- §5 — RLS. The four 0009 creator-only policy sets are dropped and
-- rewritten role-based; project_members joins RLS. All TO authenticated
-- (anon gets nothing, the §4 matrix rule). Denial shapes per the 0009
-- convention: INSERTs raise (WITH CHECK), UPDATE/DELETE filter to 0 rows —
-- a foreign project's write reads as not-found, never a 403.
-- ---------------------------------------------------------------------------

alter table public.project_members enable row level security;

-- project_members — SELECT admits the row's own user (their memberships,
-- the browser's role badges) plus every co-member (the members dialog);
-- the definer helper is the recursion breaker. INSERT..RETURNING is safe on
-- both arms: the inviter is an owner (helper arm) and the invitee reads
-- their own row (self arm).
create policy "project_members select: self or co-member"
  on public.project_members for select to authenticated
  using (
    user_id = auth.uid()
    or public.project_member_role(project_id, auth.uid()) is not null
  );
create policy "project_members insert: project owner"
  on public.project_members for insert to authenticated
  with check (public.can_manage_project(project_id));
create policy "project_members update: project owner"
  on public.project_members for update to authenticated
  using (public.can_manage_project(project_id))
  with check (public.can_manage_project(project_id));
create policy "project_members delete: project owner"
  on public.project_members for delete to authenticated
  using (public.can_manage_project(project_id));

-- projects — reads member-wide; writes owner-only (settings + delete per
-- the issue's matrix). INSERT stays creator-claimed (the 0003 datasets
-- pattern: stamped, never spoofable) — the birth trigger above makes the
-- creator the first owner.
drop policy if exists "projects select: creator" on public.projects;
drop policy if exists "projects update: creator" on public.projects;
drop policy if exists "projects delete: creator" on public.projects;
drop policy if exists "projects insert: creator" on public.projects;

-- projects — reads member-wide; writes owner-only (settings + delete per
-- the issue's matrix). INSERT stays creator-claimed (the 0003 datasets
-- pattern: stamped, never spoofable) — the birth trigger makes the creator
-- the first owner. The SELECT policy carries the creator arm ROW-LOCAL
-- (created_by = auth.uid(), the 0009 original) alongside the membership
-- arm: INSERT..RETURNING evaluates the SELECT policy BEFORE the AFTER
-- birth trigger has inserted the owner row, so a membership-only policy
-- refuses the store's `.insert().select("id")` create path (the live-stack
-- RETURNING probe caught exactly that; the creator arm cannot widen
-- anything — created_by only ever matches the invoker's own project).
drop policy if exists "projects select: creator" on public.projects;
drop policy if exists "projects update: creator" on public.projects;
drop policy if exists "projects delete: creator" on public.projects;
drop policy if exists "projects insert: creator" on public.projects;

create policy "projects select: member or creator"
  on public.projects for select to authenticated
  using (created_by = auth.uid() or public.can_view_project(id));
create policy "projects insert: creator"
  on public.projects for insert to authenticated with check (created_by = auth.uid());
create policy "projects update: project owner"
  on public.projects for update to authenticated
  using (public.can_manage_project(id)) with check (public.can_manage_project(id));
create policy "projects delete: project owner"
  on public.projects for delete to authenticated using (public.can_manage_project(id));

-- project_artifacts — reads member-wide; membership writes are content
-- writes (editor+). The rewritten project_artifact_owner IS the editor arm.
drop policy if exists "project_artifacts select: project creator" on public.project_artifacts;
drop policy if exists "project_artifacts insert: project creator" on public.project_artifacts;
drop policy if exists "project_artifacts update: project creator" on public.project_artifacts;
drop policy if exists "project_artifacts delete: project creator" on public.project_artifacts;

create policy "project_artifacts select: project member"
  on public.project_artifacts for select to authenticated
  using (public.can_view_project(project_id));
create policy "project_artifacts insert: project editor"
  on public.project_artifacts for insert to authenticated
  with check (public.project_artifact_owner(project_id));
create policy "project_artifacts update: project editor"
  on public.project_artifacts for update to authenticated
  using (public.project_artifact_owner(project_id))
  with check (public.project_artifact_owner(project_id));
create policy "project_artifacts delete: project editor"
  on public.project_artifacts for delete to authenticated
  using (public.project_artifact_owner(project_id));

-- publish_bundles — every member reads the press state (the workspace's
-- status line); the press itself is editor+. Every policy is ROW-LOCAL
-- through project_id (can_view/can_edit_project read only project_members):
-- a policy on publish_bundles must never read publish_bundles — the
-- helpers publish_bundle_viewable/owner do, and using them here recursed
-- to the stack-depth limit on the live-stack apply (a policy expression's
-- own-table subquery re-applies the same policy, unboundedly).
drop policy if exists "publish_bundles select: creator" on public.publish_bundles;
drop policy if exists "publish_bundles insert: creator" on public.publish_bundles;
drop policy if exists "publish_bundles update: creator" on public.publish_bundles;
drop policy if exists "publish_bundles delete: creator" on public.publish_bundles;

create policy "publish_bundles select: project member"
  on public.publish_bundles for select to authenticated
  using (public.can_view_project(project_id));
create policy "publish_bundles insert: project editor"
  on public.publish_bundles for insert to authenticated
  with check (public.can_edit_project(project_id));
create policy "publish_bundles update: project editor"
  on public.publish_bundles for update to authenticated
  using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id));
create policy "publish_bundles delete: project editor"
  on public.publish_bundles for delete to authenticated
  using (public.can_edit_project(project_id));

-- publish_bundle_members — the same split through the bundle's project.
drop policy if exists "publish_bundle_members select: bundle creator" on public.publish_bundle_members;
drop policy if exists "publish_bundle_members insert: bundle creator" on public.publish_bundle_members;
drop policy if exists "publish_bundle_members update: bundle creator" on public.publish_bundle_members;
drop policy if exists "publish_bundle_members delete: bundle creator" on public.publish_bundle_members;

create policy "publish_bundle_members select: project member"
  on public.publish_bundle_members for select to authenticated
  using (public.publish_bundle_viewable(bundle_id));
create policy "publish_bundle_members insert: project editor"
  on public.publish_bundle_members for insert to authenticated
  with check (public.publish_bundle_owner(bundle_id));
create policy "publish_bundle_members update: project editor"
  on public.publish_bundle_members for update to authenticated
  using (public.publish_bundle_owner(bundle_id))
  with check (public.publish_bundle_owner(bundle_id));
create policy "publish_bundle_members delete: project editor"
  on public.publish_bundle_members for delete to authenticated
  using (public.publish_bundle_owner(bundle_id));

-- ---------------------------------------------------------------------------
-- §6 — realtime: `projects` + `project_members` join the publication
-- (guarded, the 0013/0015 pattern — CI's bare postgres has no realtime
-- server and a co-numbered migration may already have added a member).
-- Membership changes broadcast; per-subscriber RLS stays the leak boundary
-- (a non-member subscriber receives no rows — the 0013 delivery note).
-- Replica identity stays DEFAULT (DELETE payloads carry the PK only —
-- exactly what the project channel's invalidation contract needs). There is
-- deliberately NO per-dataset channel here: projects are not dataset-
-- filterable; the client subscribes one project-scoped channel per open
-- workspace/members surface (realtime.ts's attachProjectRealtime).
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
  members text[] := array['projects', 'project_members'];
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
end
$$;

-- project_members rides REPLICA IDENTITY FULL, deliberately departing from
-- the matrix's DEFAULT-identity rule (0013's note): the channel filters on
-- project_id, and a DELETE event's filter is evaluated against the OLD row's
-- image — a DEFAULT identity carries the primary key only, so project_id is
-- absent and the broker silently drops every DELETE (verified live: the
-- subscribe-filtered member channel delivered the INSERT and the UPDATE and
-- nothing for the DELETE). These rows are six small columns — the full-image
-- cost is nil. The projects table keeps DEFAULT: its channel filters on id,
-- which IS the primary key.
--
-- One delivery boundary the policies cannot close (verified live, pinned by
-- pg-realtime.int.test.ts's membership test): realtime evaluates INSERT and
-- UPDATE deliveries against the subscriber's SELECT policy, but a DELETE's
-- row is already gone when the check runs, so DELETEs fail open and reach
-- topic subscribers regardless of membership. The app-side boundary holds:
-- the project channel is opened only by member-visible surfaces (the
-- workspace and its members dialog — an outsider's project reads as
-- not-found and never mounts them), so no legitimate subscriber is ever a
-- non-member.
alter table public.project_members replica identity full;

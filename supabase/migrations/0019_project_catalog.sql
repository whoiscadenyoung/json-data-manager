-- Project catalog — owned vs linked artifacts (issue #256; the project-centric
-- train, phase 2; docs/project-centric-experience-design.md §4.1, §4.3, §7 D1;
-- ADR 0018).
--
-- The project Catalog lands: datasets enter a project as an OWNED reference
-- (created in-project — an owned draft bound to the workspace) or a LINKED
-- reference (added from the global catalog; a pin at the chain's head, never
-- a copy), with sync_mode naming the linked reference's follow intent:
--   * manual — pinned at the add-time head; the member syncs explicitly
--     (the consumer_references pin machinery, 0009 — the badge/sync/revert
--     flows read mode/pinned_ref exactly as the versions card already does).
--   * auto   — the reference floats on head.
-- The membership's sync_mode and its fork edge's mode stay in lockstep at
-- the store layer (projects.ts); the DB records the intent, the edge is the
-- mechanism.
--
-- Breaking by design (the train's no-back-compat posture, §7):
--   * artifact_kind narrows to ('dataset','derived') — map/app memberships
--     arrive with their phases ([project 3]/[project 5]); the pre-0019 map
--     memberships and their consumer edges (consumer_kind 'map') die here.
--   * Every pre-0019 membership is LINKED (nothing could create in-project
--     yet); each one's sync_mode is derived from the edge it already carries
--     (float → 'auto', pin → 'manual') so no row's visible behavior changes
--     before the store learns the new columns.
--
-- The ADR 0017 deferred clause (recorded there as deliberately out of
-- scope): project-held DRAFT member-visibility. The first flow that can put
-- a draft into a project is #256's create/import-inside-project, so the
-- clause lands here: a dataset that is an OWNED artifact of a project is
-- readable by that project's members and writable by its editors/owner —
-- "adding a draft to a project IS sharing" (ADR 0011's rule, re-issued for
-- the PG backend as ADR 0018). LINKED drafts are deliberately NOT covered:
-- D1 makes linked a reference to a catalog-visible dataset, and a draft is
-- by definition not catalog-visible — visibility of a linked draft stays
-- governed by its creator's row (can_view_dataset's creator arm), so the
-- only route to member-visible drafts is ownership, the flow this phase
-- ships.

-- ---------------------------------------------------------------------------
-- §1 — project_artifacts: role + sync_mode, kind narrowed
-- ---------------------------------------------------------------------------

-- The pre-0019 map memberships go first (their fork-edge walk was the
-- store's job; here it is set-based) so the kind check can narrow. Data is
-- disposable (the train posture), the rows are re-ownable in [project 3].
delete from public.consumer_references
where consumer_kind = 'map'
  and consumer_id in (
    select pa.id::text from public.project_artifacts pa where pa.artifact_kind = 'map'
  );
-- The membership rows themselves (and any map edge whose membership row is
-- already gone — a dangling consumer_id is unattributable, so it dies too).
delete from public.consumer_references where consumer_kind = 'map';
delete from public.project_artifacts where artifact_kind = 'map';

alter table public.project_artifacts
  add column role      text not null default 'linked' check (role in ('owned','linked')),
  add column sync_mode text not null default 'manual' check (sync_mode in ('manual','auto'));

-- The pre-0019 fleet all carries float fork edges (addArtifact minted
-- float); their intent reads as auto so the catalog's provenance chips tell
-- the truth about rows that predate the pin-at-head default.
update public.project_artifacts pa
  set sync_mode = 'auto'
  where exists (
    select 1 from public.consumer_references cr
    where cr.consumer_id = pa.id::text
      and cr.consumer_kind = 'fork'
      and cr.mode = 'float'
  );

alter table public.project_artifacts drop constraint project_artifacts_artifact_kind_check;
alter table public.project_artifacts
  add constraint project_artifacts_artifact_kind_check
  check (artifact_kind in ('dataset','derived'));

-- ---------------------------------------------------------------------------
-- §2 — the owned-draft sharing helpers (ADR 0018). SECURITY DEFINER like
-- every can_* helper (the 0003 §4 rule): they read project_artifacts +
-- project_members relative to policies that run as the definer, never the
-- datasets table, so no recursion and no just-inserted-row blind spot.
-- STABLE so they may sit in USING/WITH CHECK clauses.
-- ---------------------------------------------------------------------------

-- Does `p_user`'s membership (ANY role) cover an OWNED artifact row whose
-- artifact is `p_dataset`? The view arm — viewers read, per the role matrix.
create function public.project_holds_owned_draft(p_dataset uuid, p_user uuid)
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

-- The editor arm — editors and owners write; viewers never do.
create function public.project_holds_owned_draft_editable(p_dataset uuid, p_user uuid)
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
      and pm.role in ('owner','editor')
  )
$$;

-- ---------------------------------------------------------------------------
-- §3 — the dataset gates re-issued with the deferred clause. Same names
-- (their consumers — the datasets/entries/geometries/imports/storage
-- policies — are untouched); the two-arm shape restructured into three
-- reader arms so the new one composes:
--   creator           — everything their row allows, as before;
--   published-visible — lifecycle past draft AND visibility past 'author'
--                       (the published 'author' gate stays creator-only:
--                       project sharing never widens a PUBLISHED row);
--   owned-draft       — the ADR 0018 clause: an OWNED artifact's draft is
--                       member-visible (and, for editors, member-writable).
-- can_edit_dataset keeps both absolute gates (authenticated; lineage null —
-- a frozen row is read-only for everyone) and adds the editor arm beside
-- edit_policy 'open' / creator.
-- ---------------------------------------------------------------------------

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
          and d.published_visibility is distinct from 'author'
        )
        -- The ADR 0018 clause, DRAFT-scoped: the helpers cannot read the
        -- datasets row (they are the datasets policies' helpers), so the
        -- lifecycle gate lives HERE — an owned PUBLISHED row is never
        -- member-widened by its project; the visibility ladder (#260) owns
        -- widening published rows.
        or (d.lifecycle = 'draft' and public.project_holds_owned_draft(d.id, auth.uid()))
      )
  );
$$;

create or replace function public.can_edit_dataset(p_dataset uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id = p_dataset
      and auth.uid() is not null
      and d.lineage is null
      and (
        d.edit_policy = 'open'
        or d.created_by = auth.uid()
        -- Draft-scoped like the view arm: past the draft, the catalog's own
        -- rules (open policy / creator) govern every write again.
        or (d.lifecycle = 'draft' and public.project_holds_owned_draft_editable(d.id, auth.uid()))
      )
  );
$$;

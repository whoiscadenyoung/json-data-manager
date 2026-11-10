-- Retire the derived-dataset system (issue #301 — Views 3; ADR 0028 D1/D5).
--
-- Views (0027) replace derived datasets: a derived dataset was a virtual,
-- browser-computed spec in `derived_datasets`; a view is a real dataset
-- (`datasets.kind = 'view'`) whose rows are saved by a server-side run. The
-- app is green and disposable, so nothing is migrated — the registry, its
-- project memberships and its edges are simply dropped.
--
--   §1  Rows that name a registry row (project memberships, consumer edges,
--       bundle members) are deleted first.
--   §2  The `derived` artifact kind leaves project_artifacts' domain.
--   §3  The two RLS helpers that read derived_datasets are re-issued
--       without it (their policies keep referencing them by name).
--   §4  derived_datasets is dropped (its policies, triggers and indexes go
--       with it). The "Join into a table" mint was client-side code over this
--       table, so there is no RPC to drop.

-- §1 ---------------------------------------------------------------------

delete from public.consumer_references where consumer_kind = 'derived';
delete from public.project_artifacts where artifact_kind = 'derived';
delete from public.publish_bundle_members where kind = 'derived';

-- §2 ---------------------------------------------------------------------

alter table public.project_artifacts drop constraint project_artifacts_artifact_kind_check;
alter table public.project_artifacts
  add constraint project_artifacts_artifact_kind_check
  check (artifact_kind in ('dataset','layer','app'));

-- §3 ---------------------------------------------------------------------

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
$$;

create or replace function public.version_policy_anchor_owner(p_anchor text)
returns boolean
language sql stable security invoker set search_path = public, extensions as $$
  select exists (
    select 1 from public.datasets d
    where d.id::text = p_anchor and d.created_by = auth.uid()
  )
$$;

-- §4 ---------------------------------------------------------------------

drop table public.derived_datasets cascade;

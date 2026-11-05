-- ---------------------------------------------------------------------------
-- Closeout invariant restatement (issue #223): binding_sweep_batch and
-- binding_fail_run restate the claim/gate invariant the Convex versions
-- performed (app/convex/sources/sync.ts — sweepStaleBatch/markRunFailed
-- were internalMutations, so "only the owning run, in the owning state, may
-- sweep/fail" held structurally: no browser could call them at all). These
-- SECURITY DEFINER RPCs ARE callable by every authenticated session, so the
-- claim must travel with the call and the functions refuse foreign/stale
-- callers themselves instead of trusting every caller to be correct.
--
--   * binding_sweep_batch gains p_claim — its siblings binding_apply_rows_
--     batch / binding_apply_commits_batch / binding_finalize_run already
--     carry one — and refuses runs outside 'sweeping' and callers without
--     the owning claim ("refuse when the run is not claimed" is covered by
--     the null-claim arm: a cron-created work item has no owner to sweep).
--   * binding_fail_run keeps its signature but the unclaimed-run hole
--     closes: a run with claim null refuses every caller (there is no
--     owner; the Convex markRunFailed answered only to the server itself),
--     a claimed run answers only to its claim, and terminal states stay
--     final. The client's fail path always holds the non-null start claim
--     (bindings.ts), so no legitimate drive changes.
--
-- Both are CREATE OR REPLACE and idempotent under re-apply: the CI store
-- job, the compose migrations runner and a `supabase db reset` all replay
-- the full numbered set.
-- ---------------------------------------------------------------------------

create or replace function public.binding_sweep_batch(p_run_id uuid, p_claim text)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run     public.sync_runs;
  v_binding public.dataset_bindings;
  v_tally   jsonb;
  v_stale   record;
  v_batch   integer := 0;
  v_max     integer := public.binding_sweep_batch_size();
begin
  -- The invariant, restated (issue #223): only the owning claim, in the
  -- owning state, may sweep — the sweep deletes entries, so a foreign or
  -- stale caller must answer 0, not trust.
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status <> 'sweeping'
    or v_run.claim is null or v_run.claim is distinct from p_claim then
    return 0;
  end if;
  select * into v_binding from public.dataset_bindings where id = v_run.binding_id;

  v_tally := jsonb_build_object(
    'added', 0, 'updated', 0, 'removed', 0,
    'needsReconcile', coalesce(v_run.needs_reconcile, false),
    'ops', v_run.ops, 'truncated', v_run.truncated);

  for v_stale in
    select be.id, be.entry_id, be.entry_key
    from public.binding_entries be
    where be.binding_id = v_run.binding_id
      and be.seen_run is distinct from p_run_id::text
    limit v_max
  loop
    delete from public.entries where id = v_stale.entry_id;
    delete from public.binding_entries where id = v_stale.id;
    v_batch := v_batch + 1;
    v_tally := public.binding_record_op(v_tally, v_stale.entry_key, 'remove');
  end loop;
  v_tally := public.binding_tally_bump(v_tally, 'removed', v_batch);

  perform public.binding_patch_run_batch(p_run_id, v_tally, 0, v_run.chunk_index, v_run.row_offset);

  if v_batch < v_max then
    -- The sweep is clean — completion stamps the activity row from the run
    -- row, which now includes THIS batch's removals.
    perform public.binding_complete_run(p_run_id);
  end if;
  return v_batch;
end $$;

create or replace function public.binding_fail_run(p_run_id uuid, p_claim text, p_error text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run public.sync_runs;
begin
  -- The invariant, restated (issue #223): only the owning claim may fail a
  -- run, and only while it is still active. An unclaimed run (a cron work
  -- item no driver has taken) has NO owner — it answers to nobody, which
  -- is exactly the Convex markRunFailed posture (internalMutation: the
  -- server itself was the only caller). binding_start_run's revive path is
  -- what retires abandoned unclaimed runs.
  select * into v_run from public.sync_runs where id = p_run_id;
  if v_run.id is null or v_run.status in ('completed', 'failed')
    or v_run.claim is null or v_run.claim is distinct from p_claim then
    return;
  end if;
  update public.sync_runs
    set status = 'failed', error = p_error, finished_at = now()
    where id = p_run_id;
end $$;

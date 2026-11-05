-- ---------------------------------------------------------------------------
-- Closeout follow-ups (issue #224's PR; found during its audit):
--
-- binding_sweep_batch's signature grew p_claim in 0016 (issue #223).
-- CREATE OR REPLACE with a NEW signature creates a NEW function, so the
-- old unary kept its 0012 grants — still callable by any authenticated
-- session, now with NO claim gate (the unary body predates the invariant
-- restatement) — while the replacement binary started from the default
-- PUBLIC grant, the exact posture 0012's revoke block exists to prevent.
--
-- Restore 0012's discipline on the live signature and drop the dead
-- unary. Idempotent: re-apply replays the same catalog statements.
-- ---------------------------------------------------------------------------

revoke all on function public.binding_sweep_batch(uuid, text) from public, anon;

grant execute on function public.binding_sweep_batch(uuid, text)
  to authenticated, service_role;

drop function public.binding_sweep_batch(uuid);

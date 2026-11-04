-- ---------------------------------------------------------------------------
-- Hotfix: INSERT .. RETURNING must pass the SELECT policy on the new row.
--
-- Discovered by the 20k A/B verification (2026-11-04, night run): the app's
-- dataset create path — supabase-js `.insert(...).select("id")`, i.e. an
-- INSERT with a RETURNING clause — failed with 42501 for every real user,
-- while the same insert WITHOUT returning succeeded. Postgres evaluates the
-- SELECT policy on the new row to decide what RETURNING may hand back, and
-- the visibility helpers (`can_view_dataset`) read the `datasets` table with
-- the statement's snapshot, where the just-inserted row is not yet visible to
-- a fresh query — so the helper answered false on the very row the invoker
-- had just written (fail-closed by design). No test caught it: the int
-- fixtures create rows via direct superuser SQL, never through the
-- PostgREST create path this fix restores.
--
-- The fix arms the affected SELECT policies with the row's own attribution
-- (`created_by = auth.uid()`), which the helpers already intend to allow —
-- creators can view their own datasets/drafts (ADR 0009 trusted-collaborator
-- model; the stage-3 review cites exactly that creator-visibility clause) —
-- so RETURNING of a just-inserted row passes without weakening visibility
-- for anyone else: every other reader still goes through the helper.
--
-- Same treatment for every table whose rows carry `created_by` and whose
-- SELECT policy gates on a definer helper: datasets, entries, geometries,
-- imports. entry_references rows carry no created_by of their own — they
-- stay helper-gated; their inserts go through SQL RPCs or entry writes, not
-- PostgREST INSERT..RETURNING from the browser.
--
-- Regressed-then-verified against the live stack: insert-as-authenticated
-- with RETURNING failed before this migration (reproduced via psql with
-- request.jwt.claims set AND via raw PostgREST) and passes after.
-- ---------------------------------------------------------------------------

drop policy if exists "datasets select: can_view_dataset" on public.datasets;
create policy "datasets select: can_view_dataset"
  on public.datasets for select to authenticated
  using (created_by = auth.uid() or public.can_view_dataset(id));

drop policy if exists "entries select: can_view_dataset" on public.entries;
create policy "entries select: can_view_dataset"
  on public.entries for select to authenticated
  using (created_by = auth.uid() or public.can_view_dataset(dataset_id));

drop policy if exists "geometries select: can_view_dataset" on public.geometries;
create policy "geometries select: can_view_dataset"
  on public.geometries for select to authenticated
  using (created_by = auth.uid() or public.can_view_dataset(dataset_id));

drop policy if exists "imports select: can_view_dataset" on public.imports;
create policy "imports select: can_view_dataset"
  on public.imports for select to authenticated
  using (created_by = auth.uid() or public.can_view_dataset(dataset_id));

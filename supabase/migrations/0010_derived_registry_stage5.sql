-- Stage 5 — derived datasets + analysis + exports (docs/supabase-migration-design.md
-- §3.5/§8.1/§13 "Stage 5"; GitHub issue #204). The `derived_datasets` REGISTRY
-- TABLE itself landed in stage 4 (migration 0009 §3.5 — spec jsonb shapeless,
-- depends_on denormalized edges, status draft/saved, the
-- derived_by_status_source / derived_by_source_creator indexes), so this
-- migration carries only what stage 5 adds on top of it:
--
--   1. derived_datasets RLS tightened to the Convex registry rules (the §4
--      matrix row's intent, mirroring app/convex/versions/derivedDatasets.ts
--      READ-ONLY — stage 8 #104's recorded decisions):
--        * SAVED rows are catalog-visible to every signed-in viewer; DRAFTS
--          are creator-private on every read ("drafts are invisible to
--          consumers by the status column" — get answers null,
--          listBySource hides them, summaries reads saved only).
--        * Writes are creator-scoped: inserts are attribution-only (a new
--          row is born the caller's — the 0009 stamp trigger already
--          enforces it; the WITH CHECK states the rule), updates and
--          deletes answer to the row's creator ONLY ("UPDATES are
--          creator-only — a builder autosave never lands on another user's
--          row", derivedDatasets.ts:183-186; remove "Creator-only since
--          stage 8", derivedDatasets.ts:466).
--        * This also closes 0009's ownership-theft hole: its update policy
--          (`using (true) with check (created_by = auth.uid())`) allowed a
--          non-creator to pass by RE-TAKING created_by in the same
--          statement — the UPDATE may not change created_by matrix rule
--          needs the creator arm on the USING side, which this policy has.
--      No materialization: the registry stays virtual — consumers compute
--      through the row-resolution seam (design §8.3; issue #204).
--
--   2. Carry-over fix (stage-5 scope, tranche-1/2 review): 0006 capped
--      dataset_rows_for_tiles at 1000 rows while its own signature default
--      is 5000 (design §5.5) and its callers request 2000 (the row seam's
--      GEOMETRY_PAGE_ROWS) / 5000 (store DEFAULT_GEOMETRY_ROWS_LIMIT). The
--      signature is kept and REALITY is raised to match it: the effective
--      cap moves 1000 → 5000, so "default 5000" is true again, every
--      caller's requested page width is honored, and stage 5's analysis /
--      export bulk geometry reads page at the width the seam asks for
--      instead of paying 2–5x the round trips. The tranche-1 review's
--      actual point — p_limit = 10^7 must not materialize the whole table
--      into per-column arrays — still holds at 5000. (The alternative —
--      lowering the signature default to 1000 — would have made the §5.5
--      contract a documented deviation instead of restoring it.)
--      search_entries needs nothing: its default (200) sits under its cap
--      (1000), so its signature never lied.
--
-- No exports-history table: the design doc's schema sections (§3.1–§3.6)
-- name none for PG (checked: the only "export" mentions are the byte-faithful
-- round-trip rule over geometries.source), so exports ride the existing
-- row-resolution seam with no new state (issue #204: "an exports history
-- table only if the design doc names one").
--
-- No new bulk RPC for analysis: analyses are rows of THIS registry (sql op
-- kind — no separate analysis table, the stage-9 precedent), and the
-- DuckDB feed is the existing seam read (fetchDatasetEntryRows /
-- fetchDatasetGeometryRows over entries keyset + dataset_rows_for_tiles),
-- so the 0006 hardening rules (keyset pagination, server-side cap, SECURITY
-- INVOKER, key validation) carry with no new surface to harden.

-- ---------------------------------------------------------------------------
-- 1. derived_datasets — RLS to the Convex registry rules
-- ---------------------------------------------------------------------------

drop policy if exists "derived_datasets select: authenticated" on public.derived_datasets;
drop policy if exists "derived_datasets insert: authenticated" on public.derived_datasets;
drop policy if exists "derived_datasets update: authenticated, creator kept" on public.derived_datasets;
drop policy if exists "derived_datasets delete: authenticated" on public.derived_datasets;

-- SELECT: saved rows are the registry's published side (catalog-visible to
-- every signed-in viewer, exactly like published datasets); drafts answer
-- to their creator alone. The gate reads the row's OWN attribution/status
-- columns — no definer helper, no cross-table read — so the 0008 trap
-- (INSERT .. RETURNING evaluating the SELECT policy on the just-inserted
-- row) cannot bite: a new row is born with created_by = auth.uid() (the
-- 0009 stamp trigger runs BEFORE the WITH CHECK), so the draft INSERT's
-- RETURNING sees its own row.
create policy "derived_datasets select: saved or creator"
  on public.derived_datasets for select to authenticated
  using (status = 'saved' or created_by = auth.uid());

-- INSERT: attribution-only (derivedDatasets.ts:186 — "Inserts stay
-- attribution-only (a new row is born the caller's)"). The stamp trigger
-- makes the check true for every honest insert; it also keeps a client
-- from naming a foreign creator if the trigger were ever dropped.
create policy "derived_datasets insert: attribution-only"
  on public.derived_datasets for insert to authenticated
  with check (created_by = auth.uid());

-- UPDATE + DELETE: creator-only (stage 8 #104, D1 — derivedDatasets.ts:183,
-- :466). The USING arm is the theft fix: a non-creator's row never enters
-- the update at all, so created_by cannot be re-taken; the WITH CHECK arm
-- keeps a creator from forking the row to someone else's id.
create policy "derived_datasets update: creator"
  on public.derived_datasets for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy "derived_datasets delete: creator"
  on public.derived_datasets for delete to authenticated
  using (created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. dataset_rows_for_tiles — cap realigned with the §5.5 signature
-- (0006's rewrite, byte-identical except the clamp and its comment)
-- ---------------------------------------------------------------------------

create or replace function public.dataset_rows_for_tiles(
  p_dataset uuid,
  p_cursor  text    default null,
  p_limit   integer default 5000
)
returns table (
  entry_id uuid, data jsonb, geometry jsonb, geometry_source_path text,
  geometry_type text, bbox double precision[], next_cursor text
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_cursor_id uuid;
  v_limit     integer;
  v_ids       uuid[];
  v_datas     jsonb[];
  v_sources   jsonb[];
  v_paths     text[];
  v_gtypes    text[];
  v_bboxes    double precision[][];
  v_next_id   uuid;
  v_next      text;
begin
  -- Keyset by entry id. next_cursor follows the §5 intro blanket rule
  -- ("every RPC that pages returns next_cursor, null = exhausted") — the
  -- store's PagedRpcRow reads it off the last row, so exhaustion can never
  -- depend on the short-page convention alone.
  if p_cursor is not null then
    begin
      v_cursor_id := (convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb ->> 'i')::uuid;
    exception when others then
      raise exception 'invalid cursor';
    end;
    if v_cursor_id is null then
      raise exception 'invalid cursor';
    end if;
  end if;

  -- One extra row beyond p_limit decides exhaustion, exactly like §5.1; the
  -- cursor payload is the same opaque base64 {"i": "<entry uuid>"} shape.
  -- Server-side cap (tranche-1 review, same as search_entries): the worker
  -- pages via next_cursor, so a smaller effective page costs round trips,
  -- never correctness — while p_limit = 10^7 can no longer materialize the
  -- whole table into per-column arrays in one call.
  -- 0010 (stage-5 carry-over fix): the cap is the §5.5 DEFAULT the signature
  -- declares (5000), not 0006's 1000 — the signature/default and reality now
  -- agree, and the callers' requested widths (the row seam's 2000, the
  -- worker's 5000) are honored instead of silently halved.
  v_limit := least(greatest(1, coalesce(p_limit, 5000)), 5000);

  -- array_agg ORDER BY q.entry_id: this function EMITS and CURSORS off the
  -- array positions (v_ids[v_limit] is the next page's keyset boundary), so
  -- the aggregate order is load-bearing and must be structural, not
  -- plan-dependent.
  select array_agg(q.entry_id order by q.entry_id), array_agg(q.data order by q.entry_id),
         array_agg(q.geometry order by q.entry_id),
         array_agg(q.geometry_source_path order by q.entry_id), array_agg(q.geometry_type order by q.entry_id),
         array_agg(q.bbox order by q.entry_id),
         (array_agg(q.entry_id order by q.entry_id))[v_limit + 1]
  into v_ids, v_datas, v_sources, v_paths, v_gtypes, v_bboxes, v_next_id
  from (
    select e.id as entry_id, e.data, g.source as geometry,
           g.source_path as geometry_source_path, e.geometry_type, g.bbox
    from public.entries e
    join public.geometries g on g.entry_id = e.id
    where e.dataset_id = p_dataset
      and (v_cursor_id is null or e.id > v_cursor_id)
    order by e.id
    limit v_limit + 1
  ) q;

  -- The (p_limit+1)th row only decides exhaustion; the cursor encodes the
  -- LAST EMITTED row's id (the p_limit-th), exactly as §5.1's
  -- "next_cursor is the LAST RETURNED row's sort tuple" rule does — encoding
  -- the probe row would swallow one real row per page.
  if v_next_id is not null then
    v_next := encode(
      convert_to(jsonb_build_object('i', v_ids[v_limit])::text, 'utf8'), 'base64');
  end if;

  -- Emit at most p_limit rows: the (p_limit+1)th only decided exhaustion.
  for i in 1 .. least(v_limit, coalesce(array_length(v_ids, 1), 0)) loop
    entry_id             := v_ids[i];
    data                 := v_datas[i];
    geometry             := v_sources[i];
    geometry_source_path := v_paths[i];
    geometry_type        := v_gtypes[i];
    bbox                 := v_bboxes[i];
    next_cursor          := v_next;
    return next;
  end loop;
end $$;

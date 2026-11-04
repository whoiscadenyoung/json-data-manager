-- ---------------------------------------------------------------------------
-- Stage 6 realtime enablement (#205, PR #214 review fix): the matrix tables
-- join the `supabase_realtime` publication.
--
-- The review finding: stage 6 shipped the client layer (realtime.ts — one
-- postgres_changes channel per active dataset) but NO migration had added a
-- single table to the publication (`grep -rn "supabase_realtime" supabase/
-- migrations/` found nothing; `select count(*) from pg_publication_tables
-- where pubname = 'supabase_realtime'` answered 0 on the live stack). The
-- realtime broker reads the publication's table list server-side, so every
-- channel opened, carried the full matrix, and delivered NOTHING — every
-- #205 acceptance check (two-browser < 1 s, the RLS channel negative, the
-- tile live signal, §15 step-5, the §16 measurement) was unmeetable by
-- construction. The realtime.ts header's PREREQUISITE paragraph named this
-- as the stage-6 integrator's job; this migration is that job.
--
-- The eight tables are the DATASET_CHANNEL_TABLES matrix realtime.ts
-- subscribes per active dataset, in the same order:
--   entries, geometries,
--   datasets (the row itself — summaries and the tile live signal ride its
--     trigger-maintained columns),
--   dataset_versions, tags, collection_datasets, map_layers, layer_styles.
--
-- GUARDED, on purpose: CI's int-test job applies this file with
-- ON_ERROR_STOP=1 against a bare supabase/postgres service container that
-- runs no realtime server and may not pre-create the publication (CLI-managed
-- local stacks do; plain postgres init does not) — and a co-numbered
-- migration from another branch could already have added a member. So:
--   * the publication is created when absent,
--   * each table is added only when not already a member.
-- Both guards are catalog-only and transactional (publications have no
-- non-transactional DDL; that restriction is subscriptions' alone).
--
-- DELIVERY SEMANTICS DELIBERATELY NOT TOUCHED HERE:
--   * Replica identity stays DEFAULT on every matrix table, so DELETE
--     payloads carry the primary key columns only — the exact shape
--     realtime.ts documents and dispatches on (entries/datasets delete-patch
--     by PK; geometries invalidates because its cached rows key on entry_id,
--     not the geometry's own uuid).
--   * RLS stays the leak boundary: postgres_changes evaluates the table's
--     SELECT policies PER SUBSCRIBER (design §7), so a subscriber without
--     read access to a dataset receives none of its events. The committed
--     live-stack proof is pg-realtime.int.test.ts (§15 step-5's "RLS-
--     respecting channel receives only permitted rows", run in this PR with
--     the §16 10+-subscriber measurement it unblocked).
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
  -- realtime.ts DATASET_CHANNEL_TABLES, same order.
  matrix text[] := array[
    'entries',
    'geometries',
    'datasets',
    'dataset_versions',
    'tags',
    'collection_datasets',
    'map_layers',
    'layer_styles'
  ];
  t text;
begin
  foreach t in array matrix loop
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

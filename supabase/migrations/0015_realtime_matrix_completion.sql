-- ---------------------------------------------------------------------------
-- Closeout matrix completion (issue #222): the two versioning surfaces the
-- stage-6 review recorded OUTSIDE the realtime publication join
-- supabase_realtime, and the app-builder's apps table rides along per the
-- recorded default (in).
--
-- The finding: consumer_references (the pin/float consumption edges — the
-- consumed-by list and the drift badges) and version_policies (the keep-N /
-- pinned-refs retention row) are surfaces the client reads per dataset, but
-- no migration had put them in the publication — edits to them never
-- broadcast, so a second browser watching the versions card silently missed
-- pin flips and policy changes. 0013_realtime_publication.sql carried the
-- original eight; this file completes the matrix.
--
-- apps joins the PUBLICATION per #222's recorded default (in — in-builder
-- live collaboration suggests eventually wanting it), but there is
-- deliberately NO client channel for it: the per-dataset channel's contract
-- is a dataset-scoped filter column, and apps has none (0014's autosave is
-- its own client flow). Broadcast enablement is not a subscription; a
-- builder live-collaboration channel is feature work outside this closeout
-- (0014's "optional" note resolves to exactly this split).
--
-- Same guards as 0013, on purpose: CI's int-test job applies this file
-- against a bare postgres service that runs no realtime server and may not
-- pre-create the publication, and a co-numbered migration from another
-- branch could already have added a member. Both guards are catalog-only
-- and transactional. Replica identity stays DEFAULT (DELETE payloads carry
-- the primary key only — consumer_references' `id`, so its DELETE
-- invalidates the source-side key precisely and the consumer-side key not
-- at all; version_policies' PK IS the dataset_key the channel filters on).
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
  -- The completion set: the stage-6 review's two missing tables, plus apps
  -- (publication-only — see the header).
  matrix text[] := array[
    'apps',
    'consumer_references',
    'version_policies'
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

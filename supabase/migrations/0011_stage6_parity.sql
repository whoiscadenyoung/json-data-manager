-- ---------------------------------------------------------------------------
-- Stage 6 parity patches (#205, tranche-3 review) — two recorded-not-fixed
-- findings on the stage-4 versioning/publishing domain, each a one-spot
-- change with its evidence:
--
-- 1. publish_version's existing-row lookups were GLOBAL: `where ref =
--    p_publish_key` (the by-ref short-circuit) answered a ref frozen under
--    ANY chain with that chain's version id — a cross-dataset key collision
--    would hand the caller ANOTHER dataset's version id to checkpoint (the
--    UI's `bundleId:memberId` keys make collisions unreachable today, but
--    the RPC should be self-defending). Both existing-row returns now scope
--    to the caller's dataset:
--      * the by-ref short-circuit,
--      * the idempotency-race re-select — because publish_version stamps
--        publish_key = ref, a foreign chain's colliding ref INSERTs past
--        the scoped lookup, hits ON CONFLICT (publish_key), and the GLOBAL
--        race re-select would re-introduce exactly the foreign answer the
--        scoped lookup removed (caught by the int test on the live stack:
--        the by-ref guard alone still returned the other dataset's row).
--    A collision now returns NULL — the caller's "no version id" error —
--    instead of someone else's row. The ref column stays globally unique —
--    "a ref never freezes twice" holds; the lookups just stop crossing
--    chains.
--
-- 2. tags RLS was flat `authenticated` on every statement, so any
--    signed-in user could list the tags of a FOREIGN DRAFT (existence
--    leak: tag rows carry name + version_id + retired_at). The SELECT
--    policy now gates on can_view_dataset(dataset_id) with the creator
--    clause the 0008 lesson requires for helper-gated SELECT policies on
--    browser-inserted tables (tags are written through PostgREST
--    INSERT..RETURNING — the store's create uses .insert(...).select() —
--    and RETURNING evaluates the SELECT policy on the new row). The INSERT/
--    UPDATE/DELETE policies stay flat-authenticated for this stage: the
--    finding named the READ leak; tightening tag WRITES is recorded here
--    as a deliberate residual (a writer still cannot READ foreign tags
--    back unless they can view the dataset).
--
-- Re-verified against the live stack: the INSERT..RETURNING visibility
-- shape (0008's trap) cannot regress here — the creator clause answers the
-- new row, and can_view_dataset reads the datasets table, whose row predates
-- the statement.
-- ---------------------------------------------------------------------------

-- 1. publish_version, re-emitted verbatim from 0009 with the one-line
--    dataset scope on BOTH existing-row lookups (the ONLY delta — every
--    gate, the lineage stamp, the idempotency point, the materialization,
--    and the keep-N hook are untouched).
create or replace function public.publish_version(
  p_dataset       uuid,
  p_version_label text,
  p_publish_key   text,     -- idempotency key
  p_lineage       jsonb default null
)
returns uuid               -- dataset_versions.id
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_lineage jsonb;
begin
  if p_dataset is null
     or p_version_label is null or btrim(p_version_label) = ''
     or p_publish_key is null or btrim(p_publish_key) = '' then
    raise exception 'publish_version requires a dataset, a non-empty version label, and a non-empty publish key';
  end if;

  -- §4's write gate, restated for the definer (0005 pattern): locked =
  -- creator only, frozen = nobody, open = any signed-in user. This is the
  -- "RLS answers before the RPC body runs" of §5.4, expressed where the
  -- definer can enforce it.
  if not public.can_edit_dataset(p_dataset) then
    raise exception 'publish_version: dataset is not writable by the caller';
  end if;

  -- "A ref never freezes twice" — scoped to the CALLER'S chain (the stage-6
  -- parity patch; 0009 answered the global lookup): the same dataset's
  -- refrozen ref answers its existing version id (the freeze
  -- short-circuit), while a FOREIGN chain's colliding ref falls through to
  -- the INSERT below — where the publish_key conflict (publish_key = ref by
  -- construction) and the scoped race re-select answer NULL, never another
  -- dataset's row.
  select id into v_id from public.dataset_versions
    where ref = p_publish_key and dataset_id = p_dataset;
  if v_id is not null then
    return v_id;
  end if;

  -- The lineageValidator shape (component schema.ts:33-49), camelCase keys
  -- in the jsonb. A plain publish fills the narrow draft shape
  -- (publish.ts:717-727: frozenAt + snapshotRef + versionLabel — the source
  -- dataset rides the dataset_id column, which is the PG chain anchor);
  -- a caller-supplied p_lineage (stage 5's derived publishes carry recipe +
  -- sourceVersions) is kept and overlaid with the freeze-time facts.
  v_lineage := coalesce(p_lineage, '{}'::jsonb) || jsonb_build_object(
    'frozenAt',    (extract(epoch from now()) * 1000)::bigint,
    'snapshotRef', p_publish_key,
    'versionLabel', btrim(p_version_label)
  );

  -- The idempotency point (§5.4): ON CONFLICT (publish_key) DO NOTHING +
  -- re-select — a retried/killed publish cannot fork two v1s.
  -- The INVARIANT this table pair runs on: publish_key = ref BY
  -- CONSTRUCTION (the stage-6 review asked for the line) — every by-ref
  -- lookup and the ON CONFLICT target can treat the two columns as one
  -- identity only because this insert always writes them equal.
  insert into public.dataset_versions
    (dataset_id, ref, publish_key, version_label, lineage, created_by)
  values
    (p_dataset, p_publish_key, p_publish_key, btrim(p_version_label), v_lineage, auth.uid())
  on conflict (publish_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost the idempotency race to the concurrent winner: return ITS row —
    -- scoped to this chain like the by-ref lookup above (publish_key = ref
    -- by construction, so a GLOBAL re-select would re-introduce exactly the
    -- cross-chain answer the scoped lookup just removed). A miss means the
    -- key is held by a FOREIGN chain: return null — the caller's "no
    -- version id" error — never someone else's row.
    select id into v_id from public.dataset_versions
      where publish_key = p_publish_key and dataset_id = p_dataset;
    return v_id;
  end if;

  -- The materialization (§5.4): set-based INSERT..SELECT over the live
  -- entries left joined to their inline geometry, frozen verbatim.
  -- entry_id is provenance only — the jsonb row is the truth. `ordinal` is
  -- the dataset's stable read order (created_at, id — the
  -- entries_dataset_created index), so paged frozen reads are keyset-stable.
  -- KNOWN LIMITATION (recorded): storage-backed oversized geometries
  -- (> 256 KB, geometries.source_path set, source null) carry NO geometry
  -- into version_entries — the RPC cannot read Storage. Their frozen rows
  -- freeze the data jsonb only; the tile path keeps serving the live
  -- dataset. Flagged for the stage-5 review.
  insert into public.version_entries
    (version_id, entry_id, data, geometry, geometry_type, bbox, ordinal)
  select
    v_id,
    e.id,
    e.data,
    g.source,
    coalesce(g.type, e.geometry_type),
    g.bbox,
    row_number() over (order by e.created_at, e.id)
  from public.entries e
  left join public.geometries g on g.entry_id = e.id
  where e.dataset_id = p_dataset;

  -- The keep-N hook (the afterPublishCompleted pattern —
  -- consumption.ts:470 runs retention "after every publish completion so
  -- publish chains stay bounded"), same transaction as the freeze.
  perform public.enforce_version_retention(p_dataset);

  return v_id;
end $$;

-- 2. tags reads gate on the dataset's visibility (the existence-leak fix);
--    the creator clause is the 0008 lesson carried for the browser INSERT..
--    RETURNING path (the store's create reads the row straight back).
drop policy if exists "tags select: authenticated" on public.tags;
create policy "tags select: can_view_dataset or creator"
  on public.tags for select to authenticated
  using (created_by = auth.uid() or public.can_view_dataset(dataset_id));

-- Stage 2 — carry-over hardening from the tranche-1 review (items owned by
-- the SQL stage), plus the §6 storage shape stage 2 depends on.
--
-- Contents:
--   1. search_entries / dataset_rows_for_tiles:
--      - p_limit capped server-side (least(greatest(1, coalesce(p_limit,
--        <default>)), 1000)) — one call with p_limit = 10^7 previously
--        materialized the whole table into arrays (both RPCs aggregate
--        p_limit+1 rows into memory before emitting).
--      - array_agg ordering made structural (ORDER BY inside the aggregate):
--        an aggregate over an ordered subquery is NOT guaranteed to
--        preserve that order by the SQL semantics — dataset_rows_for_tiles
--        emits and cursors off array positions, so the guarantee is
--        load-bearing there too, not just in search_entries.
--      Function signatures are unchanged; create or replace rewrites the
--      bodies in place (safe on stacks where 0003 already applied — no
--      applied-migration history is rewritten, unlike editing 0003 itself).
--   2. A datasets trigger re-indexing entries' search vectors when the
--      DECLARATION changes (properties / json_schema): the entry-side
--      builder only fires on entry writes, so a newly declared key silently
--      missed every existing row.
--   3. Cross-dataset row moves blocked: the stage-1 UPDATE policies allowed
--      changing entries.dataset_id / geometries.dataset_id /
--      geometries.entry_id, which the count/bbox/tile-version maintenance
--      triggers never account for (a moved row would leave the source
--      dataset's summaries inflated). The owned-key columns become
--      immutable by trigger-raise — chosen over excluding them from the
--      column grants so the rule also holds for service-role and definer
--      paths, and the error names the rule.
--   4. §6 storage finish (0004's first hardening completed): writes to the
--      dataset-shaped buckets additionally require the object's owner stamp
--      to be the writing user; marker-sprites objects become readable by
--      every authenticated consumer (shared catalog parity with the §4
--      marker_sprites row visibility) while their writes stay
--      uploader-owned. Buckets stay private (0004's inserts); consumer
--      reads ride short-lived signed URLs at the app layer.

-- ---------------------------------------------------------------------------
-- 1a. search_entries — p_limit cap + structural array_agg ordering
-- ---------------------------------------------------------------------------

create or replace function public.search_entries(
  p_dataset uuid,
  p_query   text   default null,   -- websearch syntax; null/'' = no search filter
  p_filters jsonb  default null,   -- array of {key, op, value}; op in ('eq','neq','contains','gt','gte','lt','lte','in')
  p_sort    jsonb  default null,   -- {key, dir: 'asc'|'desc'}; null = created_at desc (the table default)
  p_cursor  text   default null,
  p_limit   integer default 200
)
returns table (
  id            uuid,
  data          jsonb,
  geometry_type text,
  created_at    timestamptz,
  next_cursor   text
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_keys        jsonb;
  v_sort_key    text;
  v_sort_dir    text;
  v_limit       integer;
  v_where       text;
  v_order       text;
  v_keyexpr     text;
  v_cond        text;
  v_f           jsonb;
  v_fkey        text;
  v_fop         text;
  v_cursor      jsonb;
  v_cursor_val  jsonb;
  v_cursor_id   uuid;
  v_cursor_ts   timestamptz;
  v_sql         text;
  v_ids         uuid[];
  v_datas       jsonb[];
  v_gtypes      text[];
  v_createds    timestamptz[];
  v_next_id     uuid;
  v_next_data   jsonb;
  v_next_created timestamptz;
  v_has_more    boolean;
  v_payload     jsonb;
  v_next        text;
  v_numre       text := '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$';
begin
  -- Server-side cap (tranche-1 review): the effective page size can never
  -- exceed 1000 rows however large p_limit is requested — the (p_limit+1)-row
  -- window and the per-aggregate arrays are otherwise attacker-shaped memory.
  -- Keyset pagination is page-size agnostic: callers chain next_cursor until
  -- null regardless of the effective size.
  v_limit := least(greatest(1, coalesce(p_limit, 200)), 1000);

  -- Key validation reads the dataset's declared properties under the
  -- invoker's RLS: an invisible dataset surfaces as "not found" (§4 denial
  -- shape), and its keys are unknowable anyway.
  select d.properties into v_keys from public.datasets d where d.id = p_dataset;
  if v_keys is null then
    raise exception 'dataset not found or not visible';
  end if;
  if jsonb_typeof(v_keys) is distinct from 'array' then
    v_keys := '[]'::jsonb;
  end if;

  -- Decode + validate the keyset cursor (opaque base64 of a jsonb payload:
  -- {"i": "<entry uuid>"} plus "s" (sort value) or "t" (created_at)).
  if p_cursor is not null then
    begin
      v_cursor := convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb;
    exception when others then
      raise exception 'invalid cursor';
    end;
    if v_cursor is null or jsonb_typeof(v_cursor) is distinct from 'object'
      or v_cursor ->> 'i' is null then
      raise exception 'invalid cursor';
    end if;
    begin
      v_cursor_id := (v_cursor ->> 'i')::uuid;
      if v_cursor ? 's' then
        v_cursor_val := v_cursor -> 's';
      end if;
      if v_cursor ? 't' then
        v_cursor_ts := (v_cursor ->> 't')::timestamptz;
      end if;
    exception when others then
      raise exception 'invalid cursor';
    end;
  end if;

  -- Validate the sort key BEFORE it reaches any SQL (§5.1 hard requirement:
  -- user input never becomes SQL — the key rides as a bound parameter even
  -- after validation; validation is the semantic gate).
  if p_sort is not null then
    if jsonb_typeof(p_sort) is distinct from 'object' then
      raise exception 'p_sort must be an object {key, dir}';
    end if;
    v_sort_key := p_sort ->> 'key';
    v_sort_dir := coalesce(p_sort ->> 'dir', 'asc');
    if v_sort_dir not in ('asc', 'desc') then
      raise exception 'invalid sort dir: %', v_sort_dir;
    end if;
    if v_sort_key is null or not (v_keys @> to_jsonb(v_sort_key)) then
      raise exception 'invalid key: %', coalesce(v_sort_key, '<null>');
    end if;
  end if;

  v_where := 'e.dataset_id = $1';
  if p_query is not null and p_query <> '' then
    v_where := v_where
      || ' and e.search @@ websearch_to_tsquery(''simple'', $2)';
  end if;

  if p_filters is not null then
    if jsonb_typeof(p_filters) is distinct from 'array' then
      raise exception 'p_filters must be an array of {key, op, value}';
    end if;
    for i in 0 .. jsonb_array_length(p_filters) - 1 loop
      v_f := p_filters -> i;
      if jsonb_typeof(v_f) is distinct from 'object' then
        raise exception 'p_filters[%] must be an object {key, op, value}', i;
      end if;
      v_fkey := v_f ->> 'key';
      v_fop  := v_f ->> 'op';
      if v_fkey is null or not (v_keys @> to_jsonb(v_fkey)) then
        raise exception 'invalid key: %', coalesce(v_fkey, '<null>');
      end if;
      if v_fop not in ('eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in') then
        raise exception 'invalid op: %', coalesce(v_fop, '<null>');
      end if;
      -- Only structural SQL (chosen from the fixed whitelist above) is
      -- interpolated; keys and values ride inside the $3 parameter.
      if v_fop = 'eq' then
        v_cond := format(
          '(e.data @> jsonb_build_object($3 -> %1$s ->> ''key'', $3 -> %1$s -> ''value''))', i);
      elsif v_fop = 'neq' then
        v_cond := format(
          '(not (e.data @> jsonb_build_object($3 -> %1$s ->> ''key'', $3 -> %1$s -> ''value'')))', i);
      elsif v_fop = 'contains' then
        -- Case-insensitive substring over data->>key (the table UI's
        -- includes() semantics); empty value matches everything.
        v_cond := format(
          '(strpos(lower(e.data ->> ($3 -> %1$s ->> ''key'')), lower(coalesce($3 -> %1$s ->> ''value'', ''''))) > 0)', i);
      elsif v_fop in ('gt', 'gte', 'lt', 'lte') then
        -- Ranges are numeric (the client's LT/GTE/etc compare Number(cell)
        -- against Number(value) and skip NaN pairs); non-numeric cell
        -- values or filter values therefore match nothing, exactly as the
        -- client's NaN guard does. CASE keeps both casts null-safe.
        v_cond := format(
          '(case when e.data ->> ($3 -> %1$s ->> ''key'') ~ %2$L then (e.data ->> ($3 -> %1$s ->> ''key''))::numeric end'
          || ' %3$s case when ($3 -> %1$s ->> ''value'') ~ %2$L then ($3 -> %1$s ->> ''value'')::numeric end)',
          i, v_numre, (case v_fop when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end));
      else  -- 'in'
        -- Exact text membership over data->>key.
        v_cond := format(
          '(lower(e.data ->> ($3 -> %1$s ->> ''key'')) in (select lower(v) from jsonb_array_elements_text(case when jsonb_typeof($3 -> %1$s -> ''value'') = ''array'' then $3 -> %1$s -> ''value'' else ''[]''::jsonb end) as v))', i);
      end if;
      v_where := v_where || ' and ' || v_cond;
    end loop;
  end if;

  -- Sort: jsonb ordering (e.data -> key) so number columns sort numerically
  -- and string columns lexicographically, matching the client's typed sort;
  -- the doc sketch's data->> would order numbers as text ("10" < "9").
  -- Missing keys: SQL NULL — PG's default null placement (asc = last,
  -- desc = first) and the keyset predicates below mirror it exactly.
  if v_sort_key is not null then
    v_keyexpr := 'e.data -> ($4 ->> ''key'')';
    if v_sort_dir = 'asc' then
      v_order := v_keyexpr || ' asc, e.id desc';
      if p_cursor is not null then
        -- Ascending is NULLS LAST, and the tiebreak runs id DESC, so
        -- "strictly after" the cursor row means: a LARGER key value, or the
        -- SAME value with a SMALLER id — plus every null-key row once the
        -- cursor carried a value (and, when the cursor itself was a null-key
        -- row, the null-key rows after it in id-desc order). A row comparison
        -- `(key, id) > ($5, $6)` would be wrong here: it resolves ties as
        -- `id > cursor_id`, which against the id-desc tiebreak re-returns
        -- already-shown rows and permanently skips the lower-id rows that
        -- share the sort value.
        v_where := v_where || format(
          ' and ((%1$s is not null and $5 is not null'
          || ' and (%1$s > $5 or (%1$s = $5 and e.id < $6)))'
          || ' or (%1$s is null and ($5 is not null or e.id < $6)))',
          v_keyexpr);
      end if;
    else
      v_order := v_keyexpr || ' desc, e.id desc';
      if p_cursor is not null then
        v_where := v_where || format(
          ' and ((%1$s is not null and (%1$s, e.id) < ($5, $6))'
          || ' or (%1$s is null and $5 is null and e.id < $6))',
          v_keyexpr);
      end if;
    end if;
  else
    v_order := 'e.created_at desc, e.id desc';
    if p_cursor is not null then
      v_where := v_where || ' and (e.created_at, e.id) < ($7, $6)';
    end if;
  end if;

  -- next_cursor is the LAST RETURNED row's sort tuple (page 2 = strictly
  -- after row p_limit); the (p_limit+1)th row is fetched only to decide
  -- exhaustion — its existence makes next_cursor non-null (§5.1, §8.3).
  -- row_number is ordered identically to the sort so rn is deterministic.
  -- Every array_agg carries ORDER BY q.rn (tranche-1 review): aggregate
  -- input order over an ordered subquery is plan-dependent in PostgreSQL —
  -- without it, a plan change could scramble the emitted page or the cursor
  -- tuple. The ORDER BY makes the emitted order structural, guaranteed.
  v_sql := 'select'
    || ' coalesce(array_agg(q.id order by q.rn) filter (where q.rn <= $8::int), ''{}'') as ids,'
    || ' coalesce(array_agg(q.data order by q.rn) filter (where q.rn <= $8::int), ''{}'') as datas,'
    || ' coalesce(array_agg(q.geometry_type order by q.rn) filter (where q.rn <= $8::int), ''{}'') as gtypes,'
    || ' coalesce(array_agg(q.created_at order by q.rn) filter (where q.rn <= $8::int), ''{}'') as createds,'
    || ' (array_agg(q.id order by q.rn) filter (where q.rn = $8::int))[1] as last_id,'
    || ' (array_agg(q.data order by q.rn) filter (where q.rn = $8::int))[1] as last_data,'
    || ' (array_agg(q.created_at order by q.rn) filter (where q.rn = $8::int))[1] as last_created,'
    || ' (array_agg(q.id order by q.rn) filter (where q.rn = $8::int + 1))[1] is not null as has_more'
    || ' from ('
    ||   ' select e.id, e.data, e.geometry_type, e.created_at,'
    ||   ' row_number() over (order by ' || v_order || ') as rn'
    ||   ' from public.entries e'
    ||   ' where ' || v_where
    ||   ' order by ' || v_order
    ||   ' limit $8::int + 1'
    || ' ) q';

  execute v_sql
    into v_ids, v_datas, v_gtypes, v_createds, v_next_id, v_next_data, v_next_created, v_has_more
    using p_dataset, p_query, p_filters, p_sort, v_cursor_val, v_cursor_id, v_cursor_ts, v_limit;

  if v_has_more and v_next_id is not null then
    v_payload := jsonb_build_object('i', v_next_id);
    if v_sort_key is not null then
      if (v_next_data -> v_sort_key) is not null then
        v_payload := v_payload || jsonb_build_object('s', v_next_data -> v_sort_key);
      end if;
    else
      v_payload := v_payload || jsonb_build_object('t', v_next_created);
    end if;
    v_next := encode(convert_to(v_payload::text, 'utf8'), 'base64');
  end if;

  for i in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    id            := v_ids[i];
    data          := v_datas[i];
    geometry_type := v_gtypes[i];
    created_at    := v_createds[i];
    next_cursor   := v_next;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1b. dataset_rows_for_tiles — p_limit cap + structural array_agg ordering
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
  v_limit := least(greatest(1, coalesce(p_limit, 5000)), 1000);

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

-- ---------------------------------------------------------------------------
-- 2. Dataset declaration changes re-index that dataset's entries
-- ---------------------------------------------------------------------------

-- The entry-side builder (0003) fires on entry writes only, so declaring a
-- new search key (or renaming the x-reference metadata a field carries)
-- silently missed every EXISTING row. Re-index on the declaration's write:
-- re-stamping `data` to itself re-fires the entries BEFORE trigger (which
-- rebuilds `search` from the dataset's now-current properties), and the
-- ride-along effects are wanted, not accidental:
--   entry_refs_maintain_update re-derives entry_references from the new
--   json_schema's x-reference fields; datasets_entries_maintain_update
--   touches datasets.updated_at.
-- Recursion is impossible: this trigger is column-scoped
-- (`update of properties, json_schema`) and the nested statements never
-- list those columns.
-- SECURITY DEFINER so the re-index runs against every row of the dataset
-- regardless of the schema-editor's entry-level RLS view.
create or replace function public.datasets_reindex_entries() returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- A write that didn't actually change either declaration (e.g. the
  -- updated_at touch from the entries maintenance trigger) re-indexes
  -- nothing.
  if new.properties is not distinct from old.properties
     and new.json_schema is not distinct from old.json_schema then
    return null;
  end if;

  update public.entries e set data = e.data where e.dataset_id = new.id;
  return null;
end $$;

drop trigger if exists datasets_reindex_entries on public.datasets;

create trigger datasets_reindex_entries
after update of properties, json_schema on public.datasets
  for each row execute function public.datasets_reindex_entries();

-- ---------------------------------------------------------------------------
-- 3. Cross-dataset row moves are rejected (owned-key columns immutable)
-- ---------------------------------------------------------------------------

-- The stage-1 UPDATE policies (`using / with check can_edit_dataset
-- (dataset_id)`) admitted moving a row to any OTHER editable dataset: both
-- sides check out and the write lands, while the count-maintenance triggers
-- — which only aggregate per-statement deltas — leave the SOURCE dataset's
-- entry_count/feature_count/bbox/map_tile_cache_version stale. Owned-key
-- columns become immutable; moving a row is delete + (re)import into the
-- target dataset, which runs the maintenance machinery exactly once per
-- side. Trigger-raise (not column-grant exclusion) so the rule also binds
-- service-role and definer paths, with an error that names the rule.
create or replace function public.entries_lock_dataset_id() returns trigger
language plpgsql as $$
begin
  if new.dataset_id is distinct from old.dataset_id then
    raise exception 'entries.dataset_id is immutable: move the row by deleting it and importing it into the target dataset';
  end if;
  return new;
end $$;

drop trigger if exists entries_dataset_id_immutable on public.entries;

create trigger entries_dataset_id_immutable before update on public.entries
  for each row execute function public.entries_lock_dataset_id();

create or replace function public.geometries_lock_owned_keys() returns trigger
language plpgsql as $$
begin
  if new.dataset_id is distinct from old.dataset_id
     or new.entry_id is distinct from old.entry_id then
    raise exception 'geometries.dataset_id and geometries.entry_id are immutable: move the geometry by deleting it and recreating it on the target row';
  end if;
  return new;
end $$;

drop trigger if exists geometries_owned_keys_immutable on public.geometries;

create trigger geometries_owned_keys_immutable before update on public.geometries
  for each row execute function public.geometries_lock_owned_keys();

-- ---------------------------------------------------------------------------
-- 4. §6 storage finish — per-object scoping with owner-stamped writes
-- ---------------------------------------------------------------------------

-- Completes 0004's first hardening to the design §6 shape. The storage
-- schema's TABLES belong to the storage-api service (0004's comment): this
-- section keeps the same loud skip when they are absent.
--
-- Dataset-shaped buckets (`geometries`, `source-files`, `tile-archives`):
--   SELECT  — can_view_dataset(first path segment). NOT owner-scoped:
--             consumers sign short-lived reads for any dataset they can
--             view (§6: "short-lived signed reads for consumers"); the
--             policy is evaluated at sign time under the signer's session.
--   INSERT /
--   UPDATE /
--   DELETE  — can_edit_dataset(first path segment) AND the object's owner
--             stamp must be the writing user (`owner_id`/`owner` are
--             stamped by the storage service from the uploader's JWT, so a
--             genuine upload always satisfies both and a spoofed or
--             foreign-owned object never does).
-- marker-sprites: objects are readable by every authenticated user (shared
-- catalog parity with the §4 matrix's marker_sprites row visibility —
-- "markers upload + render" renders OTHER users' icons too), while writes
-- stay uploader-owned. This deliberately replaces 0004's
-- "marker-sprites: uploader-owned" FOR ALL policy, whose owner-scoped
-- SELECT let only the uploader sign a read.
do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice '0006: storage tables absent (no storage-api service in this environment) — storage policies skipped';
  else
  -- 0004's first-hardening names, this file's own names, and the
  -- >63-char-truncated prefixes of the original long draft names (an
  -- identifier past the limit stores truncated, so the drop must carry the
  -- truncated form to match it) — the block stays re-runnable in any state.
  drop policy if exists "migrated dataset buckets: insert requires can_edit_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: select requires can_view_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: update requires can_edit_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: delete requires can_edit_dataset" on storage.objects;
  drop policy if exists "migrated dataset buckets: insert requires editor + owner" on storage.objects;
  drop policy if exists "migrated dataset buckets: update requires editor + owner" on storage.objects;
  drop policy if exists "migrated dataset buckets: delete requires editor + owner" on storage.objects;
  drop policy if exists "migrated dataset buckets: insert requires can_edit_dataset + ow" on storage.objects;
  drop policy if exists "migrated dataset buckets: update requires can_edit_dataset + ow" on storage.objects;
  drop policy if exists "migrated dataset buckets: delete requires can_edit_dataset + ow" on storage.objects;
  drop policy if exists "marker-sprites: uploader-owned" on storage.objects;
  drop policy if exists "marker-sprites: reads for every authenticated consumer" on storage.objects;
  drop policy if exists "marker-sprites: writes uploader-owned" on storage.objects;
  drop policy if exists "marker-sprites: updates uploader-owned" on storage.objects;
  drop policy if exists "marker-sprites: deletes uploader-owned" on storage.objects;

  create policy "migrated dataset buckets: select requires can_view_dataset"
    on storage.objects for select to authenticated
    using (
      bucket_id in ('geometries', 'source-files', 'tile-archives')
      and public.can_view_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "migrated dataset buckets: insert requires editor + owner"
    on storage.objects for insert to authenticated
    with check (
      bucket_id in ('geometries', 'source-files', 'tile-archives')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "migrated dataset buckets: update requires editor + owner"
    on storage.objects for update to authenticated
    using (
      bucket_id in ('geometries', 'source-files', 'tile-archives')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    )
    with check (
      bucket_id in ('geometries', 'source-files', 'tile-archives')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "migrated dataset buckets: delete requires editor + owner"
    on storage.objects for delete to authenticated
    using (
      bucket_id in ('geometries', 'source-files', 'tile-archives')
      and (owner_id = auth.uid()::text or owner = auth.uid())
      and public.can_edit_dataset(public.dataset_id_of_storage_path(name))
    );

  create policy "marker-sprites: reads for every authenticated consumer"
    on storage.objects for select to authenticated
    using (bucket_id = 'marker-sprites');

  create policy "marker-sprites: writes uploader-owned"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'marker-sprites'
      and (owner_id = auth.uid()::text or owner = auth.uid())
    );

  create policy "marker-sprites: updates uploader-owned"
    on storage.objects for update to authenticated
    using (
      bucket_id = 'marker-sprites'
      and (owner_id = auth.uid()::text or owner = auth.uid())
    )
    with check (
      bucket_id = 'marker-sprites'
      and (owner_id = auth.uid()::text or owner = auth.uid())
    );

  create policy "marker-sprites: deletes uploader-owned"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'marker-sprites'
      and (owner_id = auth.uid()::text or owner = auth.uid())
    );
  end if;
end
$do$;

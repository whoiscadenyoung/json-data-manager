-- Dataset relations (issue #258 — the project-centric train, phase 4;
-- docs/project-centric-experience-design.md §4.2, §5, §7 D3; ADR 0020).
--
-- The model (ArcGIS relationship classes / Power BI model relationships):
--   * `dataset_relations` — declared dataset↔dataset relations, CATALOG-LEVEL
--     rows (D3: data truth, reusable by any project holding both datasets as
--     members; presentations only consume). The creation UX lives in the
--     project catalog, but the row carries no project — a relation between
--     two global datasets exists once.
--     - kind 'key'    — config {fromKey, toKey}: a field-value join.
--     - kind 'spatial'— config {predicate, direction}: a PostGIS predicate.
--       The predicate always reads subject-against-object; direction
--       'forward' makes the FROM side the subject, 'reverse' the TO side
--       ({spatial, within, forward} ≡ {contains, reverse} — the pair exists
--       so either phrasing of one fact is declarable). At query time every
--       combo reduces to ST_Within(a, b) / ST_Intersects(a, b) over
--       (clicked, other) — ST_Contains(s, o) IS ST_Within(o, s), and
--       intersects is order-free — so the function needs no dynamic SQL.
--     - cardinality ('1-1'|'1-N'|'N-M') is the declared truth the popup
--       shapes by (1-1 inlines, lists otherwise); the query itself never
--       trusts it (the data decides how many rows answer).
--     - Ends are datasets only (the FKs). Derived datasets are virtual rows
--       computed from specs — no materialized rows to relate against until
--       the stage-5 seam lands; their layers resolve through their SOURCE
--       dataset in the runtime instead.
--   * `dataset_relation_records(...)` — the bounded runtime query the
--     relation-aware map popup runs per feature click. SECURITY INVOKER:
--     every read inside rides the caller's RLS (a viewer without visibility
--     of the other side reads zero rows, never an error leak). Bounded by
--     construction: the 2026-10 map-perf lesson — index-backed predicates
--     (entries_data_gin containment; geometries_geom_gist &&), a viewport
--     envelope scope, a hard server-side cap (500, default 200), offset
--     paging for the popup's "show more".
--
-- No realtime publication join: relations are consumed at click time (a
-- fresh query per click can't go stale) and their creation UX is the
-- catalog workspace's (TanStack invalidation covers same-tab edits); no
-- editor surface live-collaborates on relation rows. Deliberate absence —
-- the int suite pins it.
--
-- Pinned members resolve through their pinned versions: the RPC reads the
-- OTHER side's rows from `version_entries` of the side's membership pin
-- (consumer_references, 0009 — a linked member pinned at v3 answers from
-- v3's frozen rows even after the source republishes), falling back to the
-- live tables for owned/floating/non-member sides. The CLICKED side is
-- always live this phase — rendering is live until [project 5]'s frozen-row
-- snapshot work (ADR 0019).

-- ---------------------------------------------------------------------------
-- §1 — dataset_relations
-- ---------------------------------------------------------------------------

create table public.dataset_relations (
  id           uuid primary key default gen_random_uuid(),
  from_dataset uuid not null references public.datasets on delete cascade,
  to_dataset   uuid not null references public.datasets on delete cascade,
  kind         text not null check (kind in ('key','spatial')),
  -- The declared truth the popup shapes by (the query counts what the data
  -- answers, never this column).
  cardinality  text not null default 'N-M' check (cardinality in ('1-1','1-N','N-M')),
  -- key: {fromKey, toKey}; spatial: {predicate, direction}. Shapeless jsonb
  -- beyond the row-local checks below (the stored-spec rule: a typed DB
  -- check would fork from the UI validators, and schema drift must not
  -- strand the row).
  config       jsonb not null,
  created_by   uuid not null default auth.uid() references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- One relation of a kind per ordered dataset pair. The reverse pair
  -- (to→from) is a distinct row — a legitimately different declaration.
  unique (from_dataset, to_dataset, kind),
  -- Row-local config pins (the documented shapes, without pretending the DB
  -- knows the datasets' property lists). COALESCE-guarded: a missing key
  -- makes jsonb_typeof/->> return NULL, and a NULL check constraint passes
  -- vacuously — the guard is what turns "absent" into a violation.
  constraint dataset_relations_key_config_check check (
    kind <> 'key' or (
      coalesce(jsonb_typeof(config -> 'fromKey'), '') = 'string' and
      coalesce(jsonb_typeof(config -> 'toKey'), '') = 'string'
    )
  ),
  constraint dataset_relations_spatial_config_check check (
    kind <> 'spatial' or (
      coalesce(config ->> 'predicate', '') in ('within','intersects','contains') and
      coalesce(config ->> 'direction', '') in ('forward','reverse')
    )
  )
);
-- The runtime's and the catalog section's read: relations touching one
-- dataset (filtered from- or to-side — the unique constraint serves exact
-- pair lookups; these serve the "every relation touching X" scans).
create index dataset_relations_by_from on public.dataset_relations (from_dataset);
create index dataset_relations_by_to   on public.dataset_relations (to_dataset);

create trigger dataset_relations_stamp_created_by before insert on public.dataset_relations
  for each row execute function public.stamp_created_by();
create trigger dataset_relations_set_updated_at before update on public.dataset_relations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- §2 — RLS. Relations are data truth: their visibility rides the DATASETS'
-- own gates (both ends — seeing one end never leaks the other), and
-- declaring/editing one rides both ends' edit gates (the data's recorded
-- edit_policy is the relation's authority; a project editor declaring
-- inside the catalog holds can_edit_dataset on owned drafts and open
-- datasets — the D3 posture). can_view_dataset is SECURITY DEFINER over
-- datasets, so no policy-of-this-table recursion exists.
-- ---------------------------------------------------------------------------

alter table public.dataset_relations enable row level security;
create policy "dataset_relations select: both ends viewable"
  on public.dataset_relations for select to authenticated
  using (
    public.can_view_dataset(from_dataset) and public.can_view_dataset(to_dataset)
  );
create policy "dataset_relations insert: both ends editable"
  on public.dataset_relations for insert to authenticated
  with check (
    public.can_edit_dataset(from_dataset) and public.can_edit_dataset(to_dataset)
    and created_by = auth.uid()
  );
create policy "dataset_relations update: both ends editable"
  on public.dataset_relations for update to authenticated
  using (
    public.can_edit_dataset(from_dataset) and public.can_edit_dataset(to_dataset)
  )
  with check (
    public.can_edit_dataset(from_dataset) and public.can_edit_dataset(to_dataset)
  );
create policy "dataset_relations delete: both ends editable"
  on public.dataset_relations for delete to authenticated
  using (
    public.can_edit_dataset(from_dataset) and public.can_edit_dataset(to_dataset)
  );

-- ---------------------------------------------------------------------------
-- §3 — dataset_relation_records (the bounded runtime query). SECURITY
-- INVOKER: RLS applies to every table read inside (entries, geometries,
-- version_entries, project_artifacts, the relation row itself). Page shape:
-- the inner query fetches offset..offset+limit+1 (the +1 probe), the middle
-- wraps the page size, the outer trims to limit and answers has_more on
-- EVERY row (page_size = limit + 1 ⇔ a next page exists).
-- ---------------------------------------------------------------------------

create function public.dataset_relation_records(
  p_relation uuid,
  p_project  uuid,     -- the consuming map's project (drives pin resolution)
  p_dataset  uuid,     -- the clicked side (one end of p_relation)
  p_entry    uuid,     -- the clicked entry (live row — rendering is live)
  p_bbox     jsonb,    -- viewport [minLon,minLat,maxLon,maxLat]; scopes the spatial path
  p_offset   integer default 0,
  p_limit    integer default 200
)
returns table (
  entry_id      uuid,
  data          jsonb,
  geometry      jsonb,
  geometry_type text,
  has_more      boolean
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_rel            public.dataset_relations;
  v_other          uuid;
  v_clicked_is_from boolean;
  v_offset         integer := greatest(coalesce(p_offset, 0), 0);
  v_limit          integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_pinned_version uuid;
begin
  -- The relation row, through the caller's RLS (a relation whose ends the
  -- viewer can't both see reads as not-found — the no-existence-leak rule).
  select * into v_rel from public.dataset_relations where id = p_relation;
  if v_rel.id is null then
    raise exception 'Relation not found or not visible.';
  end if;
  if p_dataset = v_rel.from_dataset then
    v_clicked_is_from := true;
    v_other := v_rel.to_dataset;
  elsif p_dataset = v_rel.to_dataset then
    v_clicked_is_from := false;
    v_other := v_rel.from_dataset;
  else
    raise exception 'The clicked dataset is not an end of this relation.';
  end if;
  if not exists (
    select 1 from public.entries e where e.id = p_entry and e.dataset_id = p_dataset
  ) then
    raise exception 'The clicked entry does not belong to the clicked dataset.';
  end if;

  -- The other side's pin: its membership in the consuming project (kind
  -- dataset) with a consumer_reference edge pinned at a version (0009).
  -- No membership / float / owned ⇒ live tables.
  select cr.pinned_version_id into v_pinned_version
  from public.project_artifacts pa
  join public.consumer_references cr
    on cr.consumer_id = pa.id::text and cr.consumer_kind = 'fork'
  where pa.project_id = p_project
    and pa.artifact_kind = 'dataset'
    and pa.artifact_id = v_other::text
    and cr.mode = 'pin'
  limit 1;

  if v_rel.kind = 'key' then
    ------------------------------------------------------------------
    -- KEY: the clicked entry's field value joins the other side.
    -- fromKey names the FROM side's field, toKey the TO side's — swap by
    -- which end was clicked.
    ------------------------------------------------------------------
    declare
      v_clicked_key text;
      v_other_key   text;
      v_value       jsonb;
    begin
      v_clicked_key := v_rel.config ->> (case when v_clicked_is_from then 'fromKey' else 'toKey' end);
      v_other_key   := v_rel.config ->> (case when v_clicked_is_from then 'toKey' else 'fromKey' end);
      select e.data -> v_clicked_key into v_value
      from public.entries e where e.id = p_entry;
      if v_value is null or jsonb_typeof(v_value) = 'null' then
        -- No key value on the clicked row: honestly empty (the popup shows
        -- the section's empty state, never an error).
        return;
      end if;

      if v_pinned_version is not null then
        -- Frozen side: the pinned version's materialized rows (data jsonb;
        -- geometry rides the freeze's verbatim copy). A seq scan within one
        -- version is the frozen path's cost (jsonb @> over the version's
        -- rows; no GIN on version_entries — bounded by the version size).
        return query
        select t.entry_id, t.data, t.geometry, t.geometry_type,
               t.page_size = v_limit + 1 as has_more
        from (
          select p.*, count(*) over () as page_size
          from (
            -- The page cut is INNERMOST (windows evaluate before
            -- offset/limit — an rn inside the same query level as the cut
            -- would number the GLOBAL order and empty every offset > 0).
            select q.*, row_number() over (order by q.entry_id) as rn
            from (
              select ve.entry_id, ve.data, ve.geometry, ve.geometry_type
              from public.version_entries ve
              where ve.version_id = v_pinned_version
                and ve.data @> jsonb_build_object(v_other_key, v_value)
              order by ve.ordinal
              offset v_offset
              limit v_limit + 1
            ) q
          ) p
        ) t
        where t.rn <= v_limit;
      else
        -- Live side: containment is served by entries_data_gin
        -- (jsonb_path_ops) — the key path's index-backed answer.
        return query
        select t.entry_id, t.data, t.geometry, t.geometry_type,
               t.page_size = v_limit + 1 as has_more
        from (
          select p.*, count(*) over () as page_size
          from (
            select q.*, row_number() over (order by q.entry_id) as rn
            from (
              select e.id as entry_id, e.data, g.source as geometry, e.geometry_type
              from public.entries e
              left join public.geometries g on g.entry_id = e.id
              where e.dataset_id = v_other
                and e.data @> jsonb_build_object(v_other_key, v_value)
              order by e.id
              offset v_offset
              limit v_limit + 1
            ) q
          ) p
        ) t
        where t.rn <= v_limit;
      end if;
      return;
    end;
  end if;

  ------------------------------------------------------------------
  -- SPATIAL: PostGIS predicate between the clicked feature and the other
  -- side. The subject/object order comes from direction (§ preamble), and
  -- every combo reduces to ST_Within/ST_Intersects over (clicked, other):
  --   within   ⇒ ST_Within(subject, object) — other first when the OTHER
  --              side is the subject;
  --   contains ⇒ ST_Within(object, subject) — the within order SWAPPED;
  --   intersects ⇒ order-free.
  --   (Other-first ⇔ (predicate = 'within') = v_other_is_subject.)
  ------------------------------------------------------------------
  declare
    v_bbox               jsonb := p_bbox;
    v_min_lon            double precision;
    v_min_lat            double precision;
    v_max_lon            double precision;
    v_max_lat            double precision;
    v_clicked_geom       geometry;
    v_predicate          text;
    -- true ⇒ the other side's rows are the predicate's SUBJECT.
    v_other_is_subject   boolean;
  begin
    if v_bbox is null or jsonb_typeof(v_bbox) is distinct from 'array'
      or jsonb_array_length(v_bbox) <> 4 then
      raise exception 'p_bbox must be [minLon, minLat, maxLon, maxLat]';
    end if;
    if exists (select 1 from jsonb_array_elements(v_bbox) el where jsonb_typeof(el) <> 'number') then
      raise exception 'p_bbox must be four numbers';
    end if;
    v_min_lon := (v_bbox ->> 0)::double precision;
    v_min_lat := (v_bbox ->> 1)::double precision;
    v_max_lon := (v_bbox ->> 2)::double precision;
    v_max_lat := (v_bbox ->> 3)::double precision;
    if v_min_lon > v_max_lon or v_min_lat > v_max_lat then
      raise exception 'p_bbox must satisfy minLon <= maxLon and minLat <= maxLat';
    end if;

    -- The clicked feature's geometry, resolved server-side (tile-path clicks
    -- carry only the entry id). Storage-backed rows have no server geom —
    -- honestly empty (the same rows the tile path draws from Storage).
    select g.geom into v_clicked_geom
    from public.geometries g
    where g.entry_id = p_entry and g.geom is not null;
    if v_clicked_geom is null then
      return;
    end if;

    v_predicate := v_rel.config ->> 'predicate';
    v_other_is_subject :=
      case
        when v_predicate = 'intersects' then false  -- order-free; any branch is right
        when (v_rel.config ->> 'direction') = 'forward' then not v_clicked_is_from
        else v_clicked_is_from  -- reverse: the TO side is the subject
      end;

    if v_pinned_version is not null then
      -- Frozen side: bbox-envelope prefilter per row (cheap st_makeenvelope
      -- from the frozen [minLon,minLat,maxLon,maxLat] — no index, but no
      -- GeoJSON parse either); the exact predicate parses only the
      -- bbox-passing rows' verbatim geometry. Storage-backed frozen rows
      -- (geometry null) are skipped — publish_version's recorded caveat.
      return query
      select t.entry_id, t.data, t.geometry, t.geometry_type,
             t.page_size = v_limit + 1 as has_more
      from (
        select p.*, count(*) over () as page_size
        from (
          select q.*, row_number() over (order by q.entry_id) as rn
          from (
            select ve.entry_id, ve.data, ve.geometry, ve.geometry_type
            from public.version_entries ve
            where ve.version_id = v_pinned_version
              and ve.bbox is not null and ve.geometry is not null
              and st_makeenvelope(ve.bbox[1], ve.bbox[2], ve.bbox[3], ve.bbox[4], 4326)
                    && st_makeenvelope(v_min_lon, v_min_lat, v_max_lon, v_max_lat, 4326)
              and (
                case
                  when v_predicate = 'intersects' then
                    st_intersects(st_geomfromgeojson(ve.geometry::text), v_clicked_geom)
                  when (v_predicate = 'within') = v_other_is_subject then
                    st_within(st_geomfromgeojson(ve.geometry::text), v_clicked_geom)
                  else
                    st_within(v_clicked_geom, st_geomfromgeojson(ve.geometry::text))
                end
              )
            order by ve.ordinal
            offset v_offset
            limit v_limit + 1
          ) q
        ) p
      ) t
      where t.rn <= v_limit;
    else
      -- Live side: geom && envelope is served by geometries_geom_gist; the
      -- exact predicate rechecks the GiST candidates (the plan shape the
      -- perf criterion pins).
      return query
      select t.entry_id, t.data, t.geometry, t.geometry_type,
             t.page_size = v_limit + 1 as has_more
      from (
        select p.*, count(*) over () as page_size
        from (
          select q.*, row_number() over (order by q.entry_id) as rn
          from (
            select e.id as entry_id, e.data, g.source as geometry, e.geometry_type
            from public.entries e
            join public.geometries g on g.entry_id = e.id
            where e.dataset_id = v_other
              and g.geom is not null
              and g.geom && st_makeenvelope(v_min_lon, v_min_lat, v_max_lon, v_max_lat, 4326)
              and (
                case
                  when v_predicate = 'intersects' then st_intersects(g.geom, v_clicked_geom)
                  when (v_predicate = 'within') = v_other_is_subject then st_within(g.geom, v_clicked_geom)
                  else st_within(v_clicked_geom, g.geom)
                end
              )
            order by e.id
            offset v_offset
            limit v_limit + 1
          ) q
        ) p
      ) t
      where t.rn <= v_limit;
    end if;
    return;
  end;
end
$$;

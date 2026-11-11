-- 0032: turn a spreadsheet dataset's lat/lon columns into Point geometry
-- rows (issue #293; the PG port of the Convex-era GeospatialConversionPanel).
--
-- The coordinates are read CLIENT-side by the one shared policy
-- (@caden/data-core/coordinate-columns: detectCoordinateColumns +
-- extractPointGeometry, WGS84 lon/lat, out-of-range values rejected), so the
-- import flow and this conversion agree. This function only writes the
-- result, set-based, in chunks the caller sends:
--
--   p_points = [{ "id": <entry uuid>, "geometry": {"type":"Point",...} }, ...]
--
-- For each entry of p_dataset it upserts the INLINE geometry row (tiny
-- payloads, never storage-backed) and stamps entries.geometry_type, which no
-- geometry trigger maintains. Entries without coordinates are simply not
-- sent: they stay plain entries, nothing is dropped. The geometry triggers
-- do the rest exactly as for an import: per-row bbox, feature_count, the
-- dataset extent and the map_tile_cache_version bump the archive scheduler
-- watches. The caller flips datasets.is_geospatial / geometry_type (granted
-- columns) after the last chunk.
--
-- SECURITY INVOKER: RLS on geometries and entries (can_edit_dataset) gates
-- every row, and the 0027 guard keeps a view's rows read-only. Ids from
-- another dataset are ignored. Only Point payloads are accepted.

create function public.points_from_coordinates(
  p_dataset uuid,
  p_points  jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  if p_points is null or jsonb_typeof(p_points) is distinct from 'array' then
    raise exception 'p_points must be an array of {id, geometry}';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_points) el
    where el -> 'geometry' ->> 'type' is distinct from 'Point'
  ) then
    raise exception 'p_points geometries must be Points';
  end if;

  with payload as (
    select x.id, x.geometry
    from jsonb_to_recordset(p_points) as x(id uuid, geometry jsonb)
    join public.entries e on e.id = x.id and e.dataset_id = p_dataset
  ),
  upserted as (
    insert into public.geometries (dataset_id, entry_id, source, type, created_by)
    select p_dataset, p.id, p.geometry, 'Point', auth.uid()
    from payload p
    on conflict (entry_id) do update
      set source = excluded.source, type = excluded.type, source_path = null, source_bytes = null
    returning entry_id
  )
  update public.entries e
     set geometry_type = 'Point'
    from upserted u
   where e.id = u.entry_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.points_from_coordinates(uuid, jsonb) from public, anon;
grant execute on function public.points_from_coordinates(uuid, jsonb) to authenticated;

-- Stage 2 — the maps domain (docs/supabase-migration-design.md §3.4 block the
-- stage-2 acceptance needs, §4 matrix row, §5.6).
--
-- Tables: maps, map_layers, map_layer_overrides, layer_styles,
-- marker_sprites — field-for-field with the component shapes they mirror:
--   maps / mapLayers / mapLayerOverrides  → packages/json-cms/src/component/schema.ts:74-140
--   layerStyles / layerStyleIcons         → app/convex/layerStyles/tables.ts
-- (collections/groups/collection_datasets stay in stage 3 — the sketch's
-- catalog block minus the maps rows above, which §13 stage 2 needs for
-- "layer styles save/load; marker sprites upload + render".)
--
-- §4 matrix row for these five tables: every operation is `authenticated`
-- (shared catalog artifacts — ADR 0009, "maps stay open"). Identity is still
-- stamped (the §3 attribution rule, 0003's stamp_created_by pattern):
-- a direct PostgREST insert can neither omit nor spoof created_by /
-- updated_by / uploaded_by.
--
-- The component's delete-walks become `on delete cascade` FKs (§3.4's
-- "Deleted-with-parent cascades replace the component's explicit
-- deleteSchema/deleteGroup/deleteCollection cleanup walks").
--
-- RPC: install_tile_archive (§5.6) — the setMapTileArchive expectedVersion
-- compare-and-set, SQL edition.

-- ---------------------------------------------------------------------------
-- §3.4 — maps
-- ---------------------------------------------------------------------------

create table public.maps (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_by  uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- §3.4 — map_layers
-- ---------------------------------------------------------------------------

create table public.map_layers (
  id          uuid primary key default gen_random_uuid(),
  map_id      uuid not null references public.maps on delete cascade,
  -- `order` is a reserved word in PostgreSQL: the sketch writes it unquoted
  -- (sketch-level shorthand), but only the quoted form parses. Draw/list
  -- position — written contiguously by the client, gaps allowed after
  -- removals; only relative order matters (component schema.ts:82-88).
  "order"     integer not null,
  target_type text not null check (target_type in ('collection','group','dataset','derived')),
  -- uuid as text; 'derived' holds a derived_datasets id (stage 5). NO FK, by
  -- design — component parity incl. the dangling-target tolerance
  -- (schema.ts:89-99: deleting a derived dataset leaves its layer rows in
  -- place, readers answer "deleted derived dataset" defensively).
  target_id   text not null,
  visible     boolean not null default true
);
-- by_map / by_target, mirroring the component's mapLayers indexes
-- (schema.ts:118-120): an index scan on map_layers_by_map yields draw order
-- directly.
create index map_layers_by_map    on public.map_layers (map_id, "order");
create index map_layers_by_target on public.map_layers (target_id);

-- ---------------------------------------------------------------------------
-- §3.4 — map_layer_overrides
-- ---------------------------------------------------------------------------

create table public.map_layer_overrides (
  id        uuid primary key default gen_random_uuid(),
  layer_id  uuid not null references public.map_layers on delete cascade,
  -- 'group:<id>' | 'dataset:<id>' (component parity, schema.ts:127-131).
  child_key text not null,
  visible   boolean not null,
  -- One row per {layerId, childKey} (schema.ts:133). The unique constraint's
  -- btree also IS the component's by_layer index: layer_id is its leading
  -- column, so per-layer reads take the constraint index — a separate
  -- `by_layer (layer_id)` index would be a redundant duplicate.
  unique (layer_id, child_key)
);

-- ---------------------------------------------------------------------------
-- §3.4 — layer_styles
-- ---------------------------------------------------------------------------

create table public.layer_styles (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.maps on delete cascade,
  -- The dataset/derived id the map renders the dataset under (ADR 0012;
  -- layerStyles/tables.ts:14-17). Plain text: the same key `colorBySchema`
  -- uses, spanning both id spaces.
  render_id  text not null,
  style      jsonb not null,   -- MapLibre style-spec fragment (@caden/layer-styles validators; never widened here)
  updated_by uuid not null references public.profiles(id),  -- stamped to the invoker (below)
  updated_at timestamptz not null default now(),
  unique (map_id, render_id)   -- the component's by_mapId_and_renderId
);

-- ---------------------------------------------------------------------------
-- §3.4 — marker_sprites
-- ---------------------------------------------------------------------------

create table public.marker_sprites (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  -- marker-sprites bucket path (PNG only — ADR 0013; SVG is never stored or
  -- served). Unique = the component's by_storageId.
  storage_path text not null unique,
  sdf          boolean not null default false,
  width        integer not null,
  height       integer not null,
  pixel_ratio  double precision not null default 1,
  uploaded_by  uuid not null references public.profiles(id),  -- stamped to the invoker (below)
  uploaded_at  timestamptz not null default now()
);
create index marker_sprites_by_uploaded on public.marker_sprites (uploaded_at desc);

-- ---------------------------------------------------------------------------
-- §3 conventions — attribution + updated_at maintenance
-- ---------------------------------------------------------------------------

-- §3 attribution (0003's rule, restated): identity is stamped from the
-- request, never claimed from a client payload. Runs BEFORE the RLS WITH
-- CHECK, so the checked row carries the invoker's id.
create trigger maps_stamp_created_by before insert on public.maps
  for each row execute function public.stamp_created_by();

-- layer_styles has no created_by (the sketch's shape — a style row is
-- anonymous until first written); updated_by tracks the LAST WRITER, so it
-- is stamped on insert and on every update.
create function public.layer_styles_stamp_updated_by() returns trigger
language plpgsql as $$
begin
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger layer_styles_stamp_updated_by before insert or update on public.layer_styles
  for each row execute function public.layer_styles_stamp_updated_by();

-- marker_sprites has no created_by column for the shared stamp to set
-- (uploaded_by is its attribution column), so it gets its own one-column
-- stamp.
create function public.marker_sprites_stamp_uploaded_by() returns trigger
language plpgsql as $$
begin
  new.uploaded_by := auth.uid();
  return new;
end $$;

create trigger marker_sprites_stamp_uploaded_by before insert on public.marker_sprites
  for each row execute function public.marker_sprites_stamp_uploaded_by();

create trigger layer_styles_set_updated_at before update on public.layer_styles
  for each row execute function public.set_updated_at();
create trigger maps_set_updated_at before update on public.maps
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- §4 — RLS (the matrix's shared-catalog row: every operation `authenticated`,
-- anon gets nothing). No dataset coupling — maps reference datasets through
-- layers by text id, and "maps stay open" (ADR 0009).
-- ---------------------------------------------------------------------------

alter table public.maps              enable row level security;
alter table public.map_layers        enable row level security;
alter table public.map_layer_overrides enable row level security;
alter table public.layer_styles      enable row level security;
alter table public.marker_sprites    enable row level security;

create policy "maps select: authenticated"
  on public.maps for select to authenticated using (true);
create policy "maps insert: authenticated"
  on public.maps for insert to authenticated with check (true);
create policy "maps update: authenticated"
  on public.maps for update to authenticated using (true) with check (true);
create policy "maps delete: authenticated"
  on public.maps for delete to authenticated using (true);

create policy "map_layers select: authenticated"
  on public.map_layers for select to authenticated using (true);
create policy "map_layers insert: authenticated"
  on public.map_layers for insert to authenticated with check (true);
create policy "map_layers update: authenticated"
  on public.map_layers for update to authenticated using (true) with check (true);
create policy "map_layers delete: authenticated"
  on public.map_layers for delete to authenticated using (true);

create policy "map_layer_overrides select: authenticated"
  on public.map_layer_overrides for select to authenticated using (true);
create policy "map_layer_overrides insert: authenticated"
  on public.map_layer_overrides for insert to authenticated with check (true);
create policy "map_layer_overrides update: authenticated"
  on public.map_layer_overrides for update to authenticated using (true) with check (true);
create policy "map_layer_overrides delete: authenticated"
  on public.map_layer_overrides for delete to authenticated using (true);

create policy "layer_styles select: authenticated"
  on public.layer_styles for select to authenticated using (true);
create policy "layer_styles insert: authenticated"
  on public.layer_styles for insert to authenticated with check (true);
create policy "layer_styles update: authenticated"
  on public.layer_styles for update to authenticated using (true) with check (true);
create policy "layer_styles delete: authenticated"
  on public.layer_styles for delete to authenticated using (true);

create policy "marker_sprites select: authenticated"
  on public.marker_sprites for select to authenticated using (true);
create policy "marker_sprites insert: authenticated"
  on public.marker_sprites for insert to authenticated with check (true);
create policy "marker_sprites update: authenticated"
  on public.marker_sprites for update to authenticated using (true) with check (true);
create policy "marker_sprites delete: authenticated"
  on public.marker_sprites for delete to authenticated using (true);

-- ---------------------------------------------------------------------------
-- §5.6 — install_tile_archive (the §5 intro's one definer exception in
-- practice: map_tile_archive_* are "server- or host-flow-owned" columns
-- (§4) and are NOT in authenticated's UPDATE column grant (0003), so a
-- SECURITY INVOKER body could never write them. SECURITY DEFINER keeps the
-- write, and the §4 gate is restated explicitly in the WHERE — RLS does not
-- apply to the definer. Returns false on BOTH denials and CAS misses, the
-- §4 "reads as not found" shape: the caller retries after re-reading
-- map_tile_cache_version either way.
-- ---------------------------------------------------------------------------

create function public.install_tile_archive(
  p_dataset          uuid,
  p_expected_version bigint,
  p_path             text,
  p_bytes            bigint,
  p_max_zoom         integer,
  p_built_version    bigint,
  p_format           integer
)
returns boolean   -- false when p_expected_version <> current map_tile_cache_version (stale rebuild detected)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_updated integer := 0;
begin
  -- The path must land in the tile-archives bucket UNDER THE DATASET the RPC
  -- is called for: the §6 storage policies scope object reads to
  -- can_view_dataset(first path segment), so an archive written to another
  -- dataset's prefix would be unreadable to this dataset's consumers (and
  -- one outside the bucket entirely would have no grant at all). A mismatch
  -- is a caller bug, not a CAS miss — raise, like search_entries raises on
  -- an invalid key. (The dataset id text is hex+dashes, never LIKE metas.)
  if p_path is null
     or p_path not like 'tile-archives/' || p_dataset::text || '/_%' then
    raise exception 'p_path must be tile-archives/<datasetId>/<name> for the dataset being installed';
  end if;

  update public.datasets d
     set map_tile_archive_path         = p_path,
         map_tile_archive_bytes        = p_bytes,
         map_tile_archive_max_zoom     = p_max_zoom,
         map_tile_archive_built_version = p_built_version,
         map_tile_archive_format       = p_format
   where d.id = p_dataset
     -- The compare-and-set (issue #129/#58): install only onto the version
     -- the worker read. A geometry write between read and install bumps
     -- map_tile_cache_version (the geometry triggers), the equality fails,
     -- and the stale archive is never claimed.
     and d.map_tile_cache_version = p_expected_version
     -- §4's write gate, restated for the definer: only editors of the
     -- dataset may claim an archive onto it.
     and public.can_edit_dataset(p_dataset);
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

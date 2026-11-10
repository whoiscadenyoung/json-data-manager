-- install_tile_archive's path guard expected the wrong convention
-- ([remedies 1] / #287, found on the live stack 2026-11-10).
--
-- The guard required `p_path like 'tile-archives/' || p_dataset || '/_%'` —
-- a bucket-QUALIFIED path — while every producer and consumer of
-- `datasets.map_tile_archive_path` uses the bucket-RELATIVE convention:
--   * the build worker uploads via `pgTileArchiveUploadPath`
--     (`<datasetId>/v<version>-<token>.pmtiles`), minted against
--     `storage.from('tile-archives')` — bucket implied;
--   * every read (`createTileArchiveUrl`, the metas feed, the OPFS pin)
--     signs `.from('tile-archives').createSignedUrl(<stored path>)` — a
--     stored prefix would double the bucket and read as absent;
--   * 0024's own frozen-path doc spells the live convention relative.
-- The worker's installs therefore raised on EVERY attempt (a caller-bug
-- exception, not a CAS miss): no dataset has ever installed an archive on
-- a PG deployment, the #184 backoff plateau retried forever, and each
-- retry leaked another uploaded-but-never-claimed object (214 orphans,
-- ~1.9 GB, on the dev stack alone). The int tests hand-built the prefixed
-- form, so the mismatch was invisible to CI.
--
-- This migration re-issues the function with the guard matching the stored
-- convention: `p_path like p_dataset::text || '/_%'` (bucket-relative,
-- first segment = the dataset being installed for). The cross-dataset
-- leak guard keeps its teeth — an archive claimed onto another dataset's
-- prefix is still rejected; only the bucket prefix (which the RPC's
-- definer already knows from the column it writes) is dropped.

create or replace function public.install_tile_archive(
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
  -- The path must sit UNDER THE DATASET the RPC is called for (bucket
  -- relative — the stored `map_tile_archive_path` convention every reader
  -- signs against; see this migration's header). A mismatch is a caller
  -- bug, not a CAS miss — raise, like search_entries raises on an invalid
  -- key. (The dataset id text is hex+dashes, never LIKE metas.)
  if p_path is null
     or p_path not like p_dataset::text || '/_%' then
    raise exception 'p_path must be <datasetId>/<name> for the dataset being installed (bucket relative)';
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

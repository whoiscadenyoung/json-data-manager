-- 0036: Views become a graph of named nodes (docs/views-node-graph-design.md,
-- ADR 0028 addendum d). There is NO conversion: the old linear definitions
-- are deleted, and so is everything that cannot survive without them.
--
--   * project memberships (artifact rows) of views — cascades to the layers
--     that style them and to map_layers placements;
--   * the views themselves — cascades to view_inputs, view_runs,
--     view_refresh_queue, export_profiles, dataset_relations (links), the
--     saved rows (entries + geometries), versions and tile bookkeeping.
--
-- `view_inputs.alias` now stores the id of the view's `source` node (the
-- column keeps its name; no function reads it as anything but an opaque key).
-- Maps and apps keep their rows; a layer that styled a deleted view is gone,
-- so they simply show fewer layers. Tile archives already uploaded to
-- storage for the deleted views become orphans (harmless, unreferenced).

delete from public.project_artifacts pa
using public.datasets d
where pa.artifact_kind = 'dataset'
  and pa.artifact_id = d.id::text
  and d.kind = 'view';

delete from public.datasets where kind = 'view';

import { ViewCompileError } from "./errors.js";
import { nodeCteName, ParamBag } from "./sql-util.js";
import type { CompileInputMeta, ViewDefinition } from "./types.js";

/** A resolved `source` node: its metadata plus the version to read (meta wins over the node's ref). */
export interface ResolvedSource {
  node: string;
  datasetId: string;
  title: string;
  version: string | undefined;
  cte: string;
}

export function resolveSource(
  def: ViewDefinition,
  metas: CompileInputMeta[],
  id: string,
): ResolvedSource {
  const node = def.nodes[id];
  const meta = metas.find((entry) => entry.node === id);
  if (node.kind !== "source") {
    throw new ViewCompileError(`Node "${id}" is not a source.`);
  }
  if (meta === undefined) {
    throw new ViewCompileError(`No input metadata for source node "${id}".`);
  }
  return {
    node: id,
    datasetId: meta.datasetId,
    title: meta.title,
    version: meta.pinnedVersion ?? node.ref.version,
    cte: nodeCteName(id),
  };
}

/**
 * The source CTE `(row_id, d, geom)`. Current rows read entries left-joined to
 * geometries; a pinned version reads the frozen version_entries (whose
 * geometry is verbatim GeoJSON, so it is parsed back into a geometry).
 */
export function sourceCte(input: ResolvedSource, bag: ParamBag): string {
  const dataset = bag.add(input.datasetId, "uuid");
  if (input.version === undefined) {
    return `${input.cte} as (
  select e.id as row_id, e.data as d, g.geom as geom
  from public.entries e
  left join public.geometries g on g.entry_id = e.id
  where e.dataset_id = ${dataset}
)`;
  }
  const version = bag.text(input.version);
  return `${input.cte} as (
  select ve.id as row_id, ve.data as d,
    case when ve.geometry is null then null
      else st_setsrid(st_geomfromgeojson(ve.geometry::text), 4326)::geometry(Geometry,4326) end as geom
  from public.version_entries ve
  join public.dataset_versions v on v.id = ve.version_id
  where v.dataset_id = ${dataset} and v.ref = ${version}
)`;
}

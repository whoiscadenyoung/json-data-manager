import { ViewCompileError } from "./errors.js";
import { inputCteName, ParamBag } from "./sql-util.js";
import type { CompileInputMeta, ViewDefinition } from "./types.js";

/** Resolved input: its metadata plus the version to read (meta wins over the definition's ref). */
export interface ResolvedInput {
  alias: string;
  datasetId: string;
  title: string;
  version: string | undefined;
  cte: string;
}

export function resolveInputs(
  def: ViewDefinition,
  metas: CompileInputMeta[],
): Map<string, ResolvedInput> {
  const byAlias = new Map(metas.map((meta) => [meta.alias, meta]));
  const resolved = new Map<string, ResolvedInput>();
  for (const input of def.inputs) {
    const meta = byAlias.get(input.alias);
    if (meta === undefined) {
      throw new ViewCompileError(`No input metadata for alias "${input.alias}".`);
    }
    resolved.set(input.alias, {
      alias: input.alias,
      datasetId: meta.datasetId,
      title: meta.title,
      version: meta.pinnedVersion ?? input.ref.version,
      cte: inputCteName(input.alias),
    });
  }
  return resolved;
}

export function getInput(inputs: Map<string, ResolvedInput>, alias: string): ResolvedInput {
  const input = inputs.get(alias);
  if (input === undefined) {
    throw new ViewCompileError(`Unknown input alias "${alias}".`);
  }
  return input;
}

/**
 * The input CTE `(row_id, d, geom)`. Current rows read entries left-joined to
 * geometries; a pinned version reads the frozen version_entries (whose
 * geometry is verbatim GeoJSON, so it is parsed back into a geometry).
 */
export function inputCte(input: ResolvedInput, bag: ParamBag): string {
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

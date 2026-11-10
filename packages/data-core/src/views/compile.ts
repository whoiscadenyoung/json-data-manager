import { buildChain } from "./chain.js";
import type { Chain } from "./chain.js";
import { diagnosticsSelect } from "./diagnostics.js";
import { ViewCompileError } from "./errors.js";
import { resolveInputs } from "./inputs.js";
import type {
  CompileInputMeta,
  CompileOptions,
  CompiledQuery,
  DiagnosticsOptions,
  ViewDefinition,
} from "./types.js";

function withClause(chain: Chain): string {
  return `with ${chain.ctes.join(",\n")}`;
}

/**
 * The output projection: keep only the declared output keys. Applied only
 * when the whole pipeline is compiled (a step preview shows every field).
 */
function outputRow(def: ViewDefinition, chain: Chain): string {
  const keys = def.output.fields.map((field) => field.key);
  if (!chain.complete || keys.length === 0) {
    return "d";
  }
  const wanted = chain.bag.jsonb(keys);
  return `coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(d) e where e.key in (select jsonb_array_elements_text(${wanted}))), '{}'::jsonb)`;
}

function limitClause(limit: number | undefined): string {
  if (limit === undefined) {
    return "";
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new ViewCompileError("limit must be a non-negative integer.");
  }
  return `\nlimit ${limit}`;
}

/**
 * Compile a view into one SELECT returning `(row_id uuid, d jsonb, geom
 * geometry)`. Params are positional ($1..$n); jsonb params are JSON strings.
 */
export function compileView(
  def: ViewDefinition,
  inputs: CompileInputMeta[],
  opts: CompileOptions = {},
): CompiledQuery {
  const chain = buildChain(def, inputs, opts);
  const d = outputRow(def, chain);
  const sql = `${withClause(chain)}
select row_id, ${d} as d, geom
from ${chain.last}${limitClause(opts.limit)}`;
  return { sql, params: chain.bag.values };
}

/**
 * Compile the diagnostics query: one row, one `diagnostics jsonb` column of
 * the shape `{ steps: [...] }` (design §8).
 */
export function compileDiagnostics(
  def: ViewDefinition,
  inputs: CompileInputMeta[],
  opts: DiagnosticsOptions = {},
): CompiledQuery {
  const chain = buildChain(def, inputs, opts);
  const sql = `${withClause(chain)}\n${diagnosticsSelect(chain.steps, chain.bag)}`;
  return { sql, params: chain.bag.values };
}

/** Distinct dataset ids the view reads, in input order (for visibility checks and lineage). */
export function viewInputDatasetIds(def: ViewDefinition, inputs: CompileInputMeta[]): string[] {
  const resolved = resolveInputs(def, inputs);
  const ids: string[] = [];
  for (const input of resolved.values()) {
    if (!ids.includes(input.datasetId)) {
      ids.push(input.datasetId);
    }
  }
  return ids;
}

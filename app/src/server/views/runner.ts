import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type {
  CompileInputMeta,
  ViewCompiler,
  ViewDefinition,
  ViewInputRef,
} from "#/lib/views/view-compiler";
import { ViewValidationError } from "#/lib/views/view-save";

import type { VerifiedClaims } from "./claims";

export { ViewValidationError };

/**
 * The SERVER-SIDE view runner (issue #300; docs/views-design.md §7). The
 * browser sends only a view id (plus a step index, or a draft DEFINITION) —
 * never SQL, never rows. This module compiles on the server and talks to
 * Postgres directly, acting as the verified user:
 *
 * - PHASE 1 (read): `begin read only` → `set local role authenticated` →
 *   the verified claims as `request.jwt.claims` → `set local
 *   statement_timeout`. Definitions, input metadata and the compiled SELECT
 *   all run on this RLS-scoped connection, exactly as through PostgREST.
 *   The transaction is ALWAYS rolled back (a sentinel throw), so even a
 *   stray plain `SET` in a compiled statement dies with it. Rows stay on
 *   the server.
 * - PHASE 2 (write): a SEPARATE transaction. It installs the verified
 *   claims and calls `view_apply_run` / `view_record_failure`, definer
 *   functions executable only by the `view_runner` role (not by
 *   authenticated); they re-check `can_edit_dataset` and input visibility
 *   against that verified user and execute no user SQL.
 */

export interface RunnerDeps {
  sql: Sql;
  compiler: ViewCompiler;
  /** `statement_timeout` for the phase-1 read, in ms. */
  timeoutMs: number;
}

export const PREVIEW_ROW_LIMIT = 50;
export const RUN_ROW_LIMIT = 1_000_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

const jsonValue = z.json();
/** A JSON value (server functions only carry serializable results). */
export type Json = z.infer<typeof jsonValue>;

export type RunOutcome =
  | { status: "ok"; runId: string; rowCount: number; diagnostics: Json }
  | { status: "error"; runId: string | null; error: string };

export interface PreviewResult {
  rows: Record<string, Json>[];
  diagnostics: Json;
}

/** Thrown inside a read transaction to roll it back while carrying the result out. */
class ReadDone<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super("read transaction done");
    this.value = value;
  }
}

type Tx = TransactionSql;

/** The first row's `name` column (undefined when there is no row). */
function cell(rows: readonly Record<string, unknown>[], name: string): unknown {
  const row = rows[0];
  return row === undefined ? undefined : row[name];
}

async function actAs(tx: Tx, who: VerifiedClaims): Promise<void> {
  await tx.unsafe(
    `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
    [JSON.stringify(who.claims), who.sub],
  );
}

/** Phase 1: runs `work` as the verified user in a read-only, always-rolled-back transaction. */
async function readAs<T>(
  deps: RunnerDeps,
  who: VerifiedClaims,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    await deps.sql.begin("read only", async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local search_path = public, extensions`);
      await tx.unsafe(`select set_config('statement_timeout', $1, true)`, [String(deps.timeoutMs)]);
      await actAs(tx, who);
      throw new ReadDone(await work(tx));
    });
  } catch (error) {
    if (error instanceof ReadDone) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ReadDone<T> is only ever thrown by the callback above with a T.
      return error.value as T;
    }
    throw error;
  }
  throw new Error("unreachable: the read transaction always rolls back");
}

const jsonRows = z.array(z.record(z.string(), jsonValue));

const savedSchema = z.object({
  definition: z.unknown(),
  inputs: z.array(
    z.object({ alias: z.string(), datasetId: z.string(), pinnedVersion: z.string().nullable() }),
  ),
});

const metaSchema = z.array(
  z.object({
    alias: z.string(),
    datasetId: z.string(),
    pinnedVersion: z.string().nullish(),
    title: z.string().nullable(),
    fields: z.array(z.string()),
  }),
);

function refsOf(inputs: z.infer<typeof savedSchema>["inputs"]): ViewInputRef[] {
  return inputs.map((i) =>
    i.pinnedVersion === null
      ? { alias: i.alias, datasetId: i.datasetId }
      : { alias: i.alias, datasetId: i.datasetId, pinnedVersion: i.pinnedVersion },
  );
}

async function metaOf(tx: Tx, inputs: ViewInputRef[]): Promise<CompileInputMeta[]> {
  const rows = await tx.unsafe(`select public.view_input_meta($1::jsonb) as r`, [
    JSON.stringify(inputs),
  ]);
  const parsed = metaSchema.parse(cell(rows, "r"));
  return parsed.map((entry) => {
    // RLS hides an input the user cannot see (no title comes back). Reading it
    // anyway would silently yield ZERO rows — refuse instead (design §10).
    if (entry.title === null) {
      throw new Error(`input dataset ${entry.datasetId} is not visible to the caller`);
    }
    const meta: CompileInputMeta = {
      alias: entry.alias,
      datasetId: entry.datasetId,
      title: entry.title,
      fields: entry.fields.map((name) => ({ name })),
    };
    if (entry.pinnedVersion !== null && entry.pinnedVersion !== undefined) {
      meta.pinnedVersion = entry.pinnedVersion;
    }
    return meta;
  });
}

function validated(
  deps: RunnerDeps,
  definition: unknown,
  meta: CompileInputMeta[],
): ViewDefinition {
  const result = deps.compiler.validateViewDefinition(definition, meta);
  if (!result.ok) {
    throw new ViewValidationError(result.errors);
  }
  const declared = new Set(meta.map((m) => m.datasetId));
  const undeclared = deps.compiler
    .viewInputDatasetIds(result.value, meta)
    .filter((id) => !declared.has(id));
  if (undeclared.length > 0) {
    throw new ViewValidationError(
      undeclared.map((id) => ({
        path: "inputs",
        message: `the definition reads dataset ${id}, which is not a declared input`,
      })),
    );
  }
  return result.value;
}

function columnsOf(kind: "rows" | "diagnostics" | "raw"): string {
  if (kind === "rows") {
    return "q.row_id, q.d, case when q.geom is null then null else st_asgeojson(q.geom)::jsonb end as geom";
  }
  // raw: every column as JSON (geometry becomes GeoJSON through PostGIS's json cast).
  return kind === "raw" ? "to_jsonb(q) as r" : "q.*";
}

/**
 * Executes a compiled SELECT capped at maxRows. The subquery wrapper forbids
 * a stacked statement; for the rows query geometry leaves as GeoJSON (the
 * diagnostics query is one jsonb column and is left alone).
 */
async function execute(
  tx: Tx,
  compiled: { sql: string; params: unknown[] },
  maxRows: number,
  kind: "rows" | "diagnostics" | "raw",
): Promise<Record<string, Json>[]> {
  const columns = columnsOf(kind);
  const wrapped = `select ${columns} from (${compiled.sql}) q limit ${maxRows + 1}`;
  const rows = await tx.unsafe(wrapped, compiled.params.map(paramOf));
  if (rows.length > maxRows) {
    throw new Error(`the view result exceeds ${maxRows} rows`);
  }
  return jsonRows.parse(rows.map((row) => Object.fromEntries(Object.entries(row))));
}

function paramOf(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  return JSON.stringify(value);
}

function diagnosticsOf(rows: Record<string, Json>[]): Json {
  const first = rows[0];
  return first === undefined ? null : (first["diagnostics"] ?? null);
}

async function loadSaved(tx: Tx, viewId: string) {
  const rows = await tx.unsafe(`select public.view_definition($1::uuid) as r`, [viewId]);
  const raw = cell(rows, "r");
  if (raw === null || raw === undefined) {
    throw new Error(`View ${viewId} was not found (or is not visible).`);
  }
  return savedSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type PreviewTarget =
  | { viewId: string; uptoStep?: number }
  /** A draft (unsaved) definition: JSON, validated here, never SQL. */
  | { definition: unknown; inputs: ViewInputRef[]; uptoStep?: number };

/** Compiled up to `uptoStep` with LIMIT 50, plus the full-input diagnostics. */
export async function previewAs(
  deps: RunnerDeps,
  who: VerifiedClaims,
  target: PreviewTarget,
): Promise<PreviewResult> {
  return await readAs(deps, who, async (tx) => {
    let definition: unknown;
    let refs: ViewInputRef[];
    if ("viewId" in target) {
      const saved = await loadSaved(tx, target.viewId);
      definition = saved.definition;
      refs = refsOf(saved.inputs);
    } else {
      definition = target.definition;
      refs = target.inputs;
    }
    const meta = await metaOf(tx, refs);
    const def = validated(deps, definition, meta);
    const step = target.uptoStep === undefined ? {} : { uptoStep: target.uptoStep };
    const rows = await execute(
      tx,
      deps.compiler.compileView(def, meta, { ...step, limit: PREVIEW_ROW_LIMIT }),
      PREVIEW_ROW_LIMIT,
      "rows",
    );
    const diag = await execute(
      tx,
      deps.compiler.compileDiagnostics(def, meta, step),
      1,
      "diagnostics",
    );
    return { rows, diagnostics: diagnosticsOf(diag) };
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface ReadResult {
  versions: Record<string, unknown>;
  rows: Record<string, Json>[];
  diagnostics: Json;
}

/**
 * Runs a saved view: phase 1 (gate + versions captured BEFORE the read, then
 * rows + diagnostics, all read-only as the user), then phase 2 in a separate
 * write transaction. A viewer is refused at the gate (the error propagates,
 * nothing is recorded); any later failure is recorded as an errored run and
 * the previous rows stay.
 *
 * Entry ids are derived in phase 2 (`md5(view || row_id || occurrence)`), not
 * the compiler's `row_id`, which is the input's own global primary key.
 */
export async function runViewAs(
  deps: RunnerDeps,
  who: VerifiedClaims,
  viewId: string,
): Promise<RunOutcome> {
  const startedAt = new Date().toISOString();
  // The gate is its own read so a refusal throws before any failure record.
  const versions = await readAs(deps, who, async (tx) => {
    const rows = await tx.unsafe(`select public.view_input_versions($1::uuid) as r`, [viewId]);
    return z.record(z.string(), z.unknown()).parse(cell(rows, "r"));
  });

  let read: ReadResult | undefined;
  try {
    read = await readAs(deps, who, async (tx) => {
      const saved = await loadSaved(tx, viewId);
      const meta = await metaOf(tx, refsOf(saved.inputs));
      const def = validated(deps, saved.definition, meta);
      const rows = await execute(tx, deps.compiler.compileView(def, meta), RUN_ROW_LIMIT, "rows");
      const diag = await execute(tx, deps.compiler.compileDiagnostics(def, meta), 1, "diagnostics");
      return { versions, rows, diagnostics: diagnosticsOf(diag) };
    });
    const result = read;
    const runId = await deps.sql.begin(async (tx) => {
      await actAs(tx, who);
      const out = await tx.unsafe(
        `select public.view_apply_run($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5::timestamptz) as r`,
        [
          viewId,
          JSON.stringify(result.rows),
          JSON.stringify(result.versions),
          JSON.stringify(result.diagnostics),
          startedAt,
        ],
      );
      return z.string().parse(cell(out, "r"));
    });
    return { status: "ok", runId, rowCount: result.rows.length, diagnostics: result.diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let runId: string | null = null;
    try {
      runId = await deps.sql.begin(async (tx) => {
        await actAs(tx, who);
        const out = await tx.unsafe(
          `select public.view_record_failure($1::uuid, $2, $3::timestamptz, $4::jsonb, $5::jsonb) as r`,
          [
            viewId,
            message,
            startedAt,
            JSON.stringify(versions),
            JSON.stringify(read === undefined ? null : read.diagnostics),
          ],
        );
        return z.string().parse(cell(out, "r"));
      });
    } catch {
      // Best-effort: the original error is the news.
    }
    return { status: "error", runId, error: message };
  }
}

// ---------------------------------------------------------------------------
// Raw read-only entry (Scratch query, #306)
// ---------------------------------------------------------------------------

/**
 * Runs ONE caller-supplied SELECT as the verified user, with exactly the same
 * guards as a view run's phase 1 and none of them duplicated: the verified
 * claims and `authenticated` role (so RLS applies and it reaches nothing the
 * REST API does not already expose), a read-only always-rolled-back
 * transaction, `statement_timeout`, and a row cap. Rows are returned to the
 * caller, never accepted from it. The Scratch pad (#306) calls this with SQL
 * over the compiler's input-CTE layout.
 */
export async function runReadOnlyAsUser(
  deps: RunnerDeps,
  who: VerifiedClaims,
  sql: string,
  params: unknown[],
  options: { maxRows?: number } = {},
): Promise<Record<string, Json>[]> {
  const maxRows = options.maxRows ?? PREVIEW_ROW_LIMIT;
  const rows = await readAs(
    deps,
    who,
    async (tx) => await execute(tx, { sql, params }, maxRows, "raw"),
  );
  return rows.map((row) => {
    const value = row["r"];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  });
}

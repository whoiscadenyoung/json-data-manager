import { z } from "zod";

import type {
  CompileInputMeta,
  CompiledQuery,
  ValidationIssue,
  ViewCompiler,
  ViewDefinition,
  ViewInputRef,
} from "./view-compiler";

/**
 * The two-phase view runner, preview and save path (issue #300; design
 * §7/§10, "Runs, staleness, refresh").
 *
 * WHERE IT LIVES (decision): a pair of Postgres RPC phases, orchestrated by
 * this module over any `ViewsRpc` (the supabase-js client today; a server
 * function later, unchanged). Phase 1 (`view_input_versions`, `view_query`) is
 * READ ONLY and SECURITY INVOKER; phase 2 (`view_apply_run`,
 * `view_record_failure`) is a SECURITY DEFINER write that executes NO user
 * SQL — it receives the rows as data. They are different RPCs, therefore
 * different transactions, on every transport: user SQL can never run in a
 * transaction that can write. See docs/views-design.md §7 for the rationale.
 *
 * The compiler is INJECTED (`ViewCompiler`); nothing here imports it.
 */

/** The transport: one named Postgres RPC per call (each call = one transaction). */
export interface ViewsRpc {
  call(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ViewDeps {
  rpc: ViewsRpc;
  compiler: ViewCompiler;
}

/** Row cap of an editor preview (design §8: previews are limited to 50 rows). */
export const PREVIEW_ROW_LIMIT = 50;
/** Row cap of a run's phase-1 read (a guard against ferrying unbounded results). */
export const RUN_ROW_LIMIT = 1_000_000;

export class ViewValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Invalid view definition: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// RPC result shapes
// ---------------------------------------------------------------------------

const queryResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
});

const savedViewSchema = z.object({
  definition: z.unknown(),
  refreshMode: z.string(),
  inputs: z.array(
    z.object({
      alias: z.string(),
      datasetId: z.string(),
      pinnedVersion: z.string().nullable(),
    }),
  ),
});

const inputMetaSchema = z.array(
  z.object({
    alias: z.string(),
    datasetId: z.string(),
    pinnedVersion: z.string().nullish(),
    title: z.string().nullable(),
    fields: z.array(z.string()),
  }),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function query(deps: ViewDeps, compiled: CompiledQuery, maxRows: number) {
  const raw = await deps.rpc.call("view_query", {
    p_sql: compiled.sql,
    p_params: compiled.params,
    p_max_rows: maxRows,
  });
  return queryResultSchema.parse(raw);
}

/** `CompileInputMeta[]` for declared inputs (titles and field names come from the datasets, RLS-filtered). */
async function inputMetaOf(deps: ViewDeps, inputs: ViewInputRef[]): Promise<CompileInputMeta[]> {
  const raw = await deps.rpc.call("view_input_meta", { p_inputs: inputs });
  return inputMetaSchema.parse(raw).map((entry) => {
    const meta: CompileInputMeta = {
      alias: entry.alias,
      datasetId: entry.datasetId,
      title: entry.title ?? entry.alias,
      fields: entry.fields.map((name) => ({ name })),
    };
    if (entry.pinnedVersion !== null && entry.pinnedVersion !== undefined) {
      meta.pinnedVersion = entry.pinnedVersion;
    }
    return meta;
  });
}

function validated(deps: ViewDeps, definition: unknown, meta: CompileInputMeta[]): ViewDefinition {
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

function diagnosticsOf(rows: Record<string, unknown>[]): unknown {
  const first = rows[0];
  return first === undefined ? null : (first["diagnostics"] ?? null);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PreviewResult {
  /** At most PREVIEW_ROW_LIMIT rows of `{ row_id, d, geom }`. */
  rows: Record<string, unknown>[];
  /** Diagnostics computed over the FULL inputs, not the 50-row sample. */
  diagnostics: unknown;
}

/** Compiled up to `uptoStep` with LIMIT 50, plus the full diagnostics. */
export async function previewView(
  deps: ViewDeps,
  args: { definition: unknown; inputs: ViewInputRef[]; uptoStep?: number },
): Promise<PreviewResult> {
  const meta = await inputMetaOf(deps, args.inputs);
  const definition = validated(deps, args.definition, meta);
  const stepOption = args.uptoStep === undefined ? {} : { uptoStep: args.uptoStep };
  const rowsQuery = deps.compiler.compileView(definition, meta, {
    ...stepOption,
    limit: PREVIEW_ROW_LIMIT,
  });
  const diagnosticsQuery = deps.compiler.compileDiagnostics(definition, meta, stepOption);
  const [rows, diagnostics] = await Promise.all([
    query(deps, rowsQuery, PREVIEW_ROW_LIMIT),
    query(deps, diagnosticsQuery, 1),
  ]);
  return { rows: rows.rows, diagnostics: diagnosticsOf(diagnostics.rows) };
}

async function loadSaved(deps: ViewDeps, viewId: string) {
  const raw = await deps.rpc.call("view_definition", { p_view: viewId });
  if (raw === null || raw === undefined) {
    throw new Error(`View ${viewId} was not found (or is not visible).`);
  }
  const saved = savedViewSchema.parse(raw);
  const inputs: ViewInputRef[] = saved.inputs.map((input) =>
    input.pinnedVersion === null
      ? { alias: input.alias, datasetId: input.datasetId }
      : { alias: input.alias, datasetId: input.datasetId, pinnedVersion: input.pinnedVersion },
  );
  return { definition: saved.definition, inputs };
}

/** Preview of a SAVED view (its stored definition and inputs). */
export async function previewSavedView(
  deps: ViewDeps,
  viewId: string,
  options: { uptoStep?: number } = {},
): Promise<PreviewResult> {
  const saved = await loadSaved(deps, viewId);
  return await previewView(deps, { ...saved, ...options });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunOutcome =
  | { status: "ok"; runId: string; rowCount: number; diagnostics: unknown }
  | { status: "error"; runId: string | null; error: string };

/**
 * Runs a saved view.
 *
 * 1. `view_input_versions` — the gate (editable view, every input viewable;
 *    a viewer is refused here and the error PROPAGATES, nothing is recorded)
 *    plus each input's `data_version`, captured BEFORE the read.
 * 2. `view_query` x2 (rows, diagnostics) — READ ONLY, as the invoker.
 * 3. `view_apply_run` — one write transaction replacing the rows.
 *
 * Any failure after the gate is recorded as an errored run
 * (`view_record_failure`) and the previous rows stay untouched.
 *
 * Entry ids are NOT the compiler's `row_id` (that would collide with the
 * input's own entries.id, a global PK): phase 2 derives a deterministic
 * `md5(view || row_id || occurrence)::uuid`, so re-runs diff instead of
 * rewriting and selections survive a refresh.
 */
export async function runView(deps: ViewDeps, viewId: string): Promise<RunOutcome> {
  const startedAt = new Date().toISOString();
  const rawVersions = await deps.rpc.call("view_input_versions", { p_view: viewId });
  const versions = z.record(z.string(), z.unknown()).parse(rawVersions);

  let diagnostics: unknown = null;
  try {
    const saved = await loadSaved(deps, viewId);
    const meta = await inputMetaOf(deps, saved.inputs);
    const definition = validated(deps, saved.definition, meta);
    const rowsQuery = deps.compiler.compileView(definition, meta);
    const diagnosticsQuery = deps.compiler.compileDiagnostics(definition, meta);
    const [rows, diag] = await Promise.all([
      query(deps, rowsQuery, RUN_ROW_LIMIT),
      query(deps, diagnosticsQuery, 1),
    ]);
    diagnostics = diagnosticsOf(diag.rows);
    const runId = z.string().parse(
      await deps.rpc.call("view_apply_run", {
        p_view: viewId,
        p_rows: rows.rows,
        p_input_versions: versions,
        p_diagnostics: diagnostics,
        p_started_at: startedAt,
      }),
    );
    return { status: "ok", runId, rowCount: rows.rowCount, diagnostics };
  } catch (error) {
    const message = errorMessage(error);
    let runId: string | null = null;
    try {
      runId = z.string().parse(
        await deps.rpc.call("view_record_failure", {
          p_view: viewId,
          p_error: message,
          p_started_at: startedAt,
          p_input_versions: versions,
          p_diagnostics: diagnostics,
        }),
      );
    } catch {
      // The failure record is best-effort; the original error is the news.
    }
    return { status: "error", runId, error: message };
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export interface SaveViewArgs {
  definition: unknown;
  inputs: ViewInputRef[];
  refreshMode?: "manual" | "auto" | "live";
  outputSettings?: unknown;
}

/** Validates, then rewrites the definition and `view_inputs` (cycles and invisible inputs are refused by the database). */
export async function saveView(deps: ViewDeps, viewId: string, args: SaveViewArgs): Promise<void> {
  const meta = await inputMetaOf(deps, args.inputs);
  const definition = validated(deps, args.definition, meta);
  await deps.rpc.call("save_view", {
    p_view: viewId,
    p_definition: definition,
    p_inputs: args.inputs,
    p_refresh_mode: args.refreshMode ?? null,
    p_output_settings: args.outputSettings ?? null,
  });
}

export interface CreateViewArgs extends SaveViewArgs {
  title: string;
  description?: string;
  lifecycle?: "draft" | "published";
  visibility?: "members" | "signed-in" | "link" | "public";
  editPolicy?: "open" | "locked";
}

/** Validates, then creates the view dataset with its inputs; answers its id. */
export async function createView(deps: ViewDeps, args: CreateViewArgs): Promise<string> {
  const meta = await inputMetaOf(deps, args.inputs);
  const definition = validated(deps, args.definition, meta);
  const id = await deps.rpc.call("create_view", {
    p_title: args.title,
    p_definition: definition,
    p_inputs: args.inputs,
    p_refresh_mode: args.refreshMode ?? "manual",
    p_output_settings: args.outputSettings ?? null,
    p_lifecycle: args.lifecycle ?? "draft",
    p_visibility: args.visibility ?? "members",
    p_edit_policy: args.editPolicy ?? "open",
    p_description: args.description ?? null,
  });
  return z.string().parse(id);
}

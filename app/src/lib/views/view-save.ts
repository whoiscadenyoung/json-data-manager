import { z } from "zod";

import type {
  CompileInputMeta,
  ValidationIssue,
  ViewCompiler,
  ViewInputRef,
} from "./view-compiler";

/**
 * The view SAVE path (issue #300): validate a definition with the compiler,
 * then write it through `create_view` / `save_view`. These RPCs take
 * DEFINITIONS (JSON), never SQL, and the database re-checks everything that
 * matters (inputs visible, no cycle, editable view). Running and previewing
 * are NOT here: they live in the server-side runner (`app/src/server/views`),
 * so the browser never sends SQL or rows anywhere.
 */

/** The transport: one named Postgres RPC per call (each call = one transaction). */
export interface ViewsRpc {
  call(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ViewDeps {
  rpc: ViewsRpc;
  compiler: ViewCompiler;
}

export class ViewValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Invalid view definition: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

const inputMetaSchema = z.array(
  z.object({
    alias: z.string(),
    datasetId: z.string(),
    pinnedVersion: z.string().nullish(),
    title: z.string().nullable(),
    fields: z.array(z.string()),
  }),
);

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

export function validateDefinition(
  compiler: ViewCompiler,
  definition: unknown,
  meta: CompileInputMeta[],
) {
  const result = compiler.validateViewDefinition(definition, meta);
  if (!result.ok) {
    throw new ViewValidationError(result.errors);
  }
  const declared = new Set(meta.map((m) => m.datasetId));
  const undeclared = compiler
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

export interface SaveViewArgs {
  definition: unknown;
  inputs: ViewInputRef[];
  refreshMode?: "manual" | "auto" | "live";
  outputSettings?: unknown;
}

/** Validates, then rewrites the definition and `view_inputs` (cycles and invisible inputs are refused by the database). */
export async function saveView(deps: ViewDeps, viewId: string, args: SaveViewArgs): Promise<void> {
  const meta = await inputMetaOf(deps, args.inputs);
  const definition = validateDefinition(deps.compiler, args.definition, meta);
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
  const definition = validateDefinition(deps.compiler, args.definition, meta);
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

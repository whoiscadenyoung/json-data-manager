import { queryOptions } from "@tanstack/react-query";

import { defaultViewCompiler } from "#/lib/views/view-compiler-wiring";
import type { ViewDeps, ViewsRpc } from "#/lib/views/view-save";
import { previewViewFn, runViewFn, scratchQueryFn } from "#/server/views/functions";

import { clientOf, queryRows, throwPostgrestError, type StoreOptions } from "./client";

/**
 * The views store (issue #300). Two transports, deliberately different:
 *
 * - SAVE (`create_view` / `save_view`, definitions only) rides PostgREST RPCs
 *   under the user's own session — `supabaseViewsRpc` / `viewDeps`.
 * - RUN and PREVIEW go to the SERVER-SIDE runner through TanStack Start
 *   server functions. The browser sends a view id (plus a step index, or a
 *   draft definition as JSON) and its access token; it never sends SQL and
 *   never sees or sends rows. The server verifies the token and acts as that
 *   user (docs/views-design.md §7).
 */

/** A `ViewsRpc` over the shared supabase client: one PostgREST RPC (one transaction) per call. */
export function supabaseViewsRpc(options?: StoreOptions): ViewsRpc {
  return {
    call: async (fn, args) => {
      const { data, error } = await clientOf(options).rpc(fn, args);
      if (error !== null) {
        throwPostgrestError(error);
      }
      return data;
    },
  };
}

/** Save-path dependencies with the wired compiler (see view-compiler-wiring.ts). */
export function viewDeps(options?: StoreOptions): ViewDeps {
  return { rpc: supabaseViewsRpc(options), compiler: defaultViewCompiler };
}

async function accessTokenOf(options?: StoreOptions): Promise<string> {
  const { data, error } = await clientOf(options).auth.getSession();
  if (error !== null || data.session === null) {
    throw new Error("Sign in to run or preview a view.");
  }
  return data.session.access_token;
}

/** Runs a saved view on the server (phase 1 read-only as you, phase 2 write). */
export async function runView(viewId: string, options?: StoreOptions) {
  return await runViewFn({ data: { accessToken: await accessTokenOf(options), viewId } });
}

/** Preview of a saved view, optionally up to a step: at most 50 rows plus the full diagnostics. */
export async function previewSavedView(viewId: string, uptoStep?: number, options?: StoreOptions) {
  return await previewViewFn({
    data: { accessToken: await accessTokenOf(options), viewId, uptoStep },
  });
}

/** Preview of an unsaved DRAFT definition (JSON, validated by the server). */
export async function previewDraftView(
  definition: unknown,
  inputs: { alias: string; datasetId: string; pinnedVersion?: string }[],
  uptoStep?: number,
  options?: StoreOptions,
) {
  return await previewViewFn({
    data: { accessToken: await accessTokenOf(options), definition, inputs, uptoStep },
  });
}

/**
 * Scratch query (#306): the project's table names and, with `sql`, the result
 * of running it read-only on the server as you. Nothing is saved.
 */
export async function scratchQuery(projectId: string, sql?: string, options?: StoreOptions) {
  return await scratchQueryFn({
    data: { accessToken: await accessTokenOf(options), projectId, sql },
  });
}

export interface ViewRunRow {
  id: string;
  viewId: string;
  status: "ok" | "error";
  startedAt: string;
  finishedAt: string;
  rowCount: number | null;
  inputVersions: Record<string, unknown>;
  diagnostics: unknown;
  error: string | null;
}

/** A view's run history, newest first (editors and the creator only — RLS). */
export function listRunsQueryOptions(viewId: string, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:view_runs", viewId],
    queryFn: async () =>
      await queryRows<ViewRunRow>(
        clientOf(options)
          .from("view_runs")
          .select(
            "id,viewId:view_id,status,startedAt:started_at,finishedAt:finished_at,rowCount:row_count,inputVersions:input_versions,diagnostics,error",
          )
          .eq("view_id", viewId)
          .order("finished_at", { ascending: false })
          .limit(50),
      ),
  });
}

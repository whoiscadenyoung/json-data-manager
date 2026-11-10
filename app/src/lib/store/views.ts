import { queryOptions } from "@tanstack/react-query";

import { defaultViewCompiler } from "#/lib/views/view-compiler-wiring";
import type { ViewDeps, ViewsRpc } from "#/lib/views/view-runner";

import { clientOf, queryRows, throwPostgrestError, type StoreOptions } from "./client";

/**
 * The views store (issue #300): the supabase-js transport for the view
 * runner's RPCs, plus the run-history read. Orchestration lives in
 * `#/lib/views/view-runner`; this file only binds it to the shared client.
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

/** Runner dependencies with the wired compiler (see view-compiler-wiring.ts). */
export function viewDeps(options?: StoreOptions): ViewDeps {
  return { rpc: supabaseViewsRpc(options), compiler: defaultViewCompiler };
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

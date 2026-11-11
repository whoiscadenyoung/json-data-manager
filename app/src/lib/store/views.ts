import { queryOptions } from "@tanstack/react-query";

import { liveRowsToEntries, searchLiveEntries } from "#/lib/views/live-rows";
import { defaultViewCompiler } from "#/lib/views/view-compiler-wiring";
import type { ViewDeps, ViewsRpc } from "#/lib/views/view-save";
import {
  previewViewFn,
  readLiveViewFn,
  runViewFn,
  scratchQueryFn,
  setRefreshModeFn,
} from "#/server/views/functions";

import { clientOf, queryRows, throwPostgrestError, type StoreOptions } from "./client";
import type { SearchEntriesArgs, SearchEntriesPage } from "./entries";

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

// ---------------------------------------------------------------------------
// Refresh modes (issue #305)
// ---------------------------------------------------------------------------

/** One live read: the (capped) rows of a live view, computed now as you. */
export interface LiveViewRows {
  rows: { row_id?: unknown; d?: unknown; geom?: unknown }[];
  truncated: boolean;
  rowCap: number;
}

export async function readLiveView(viewId: string, options?: StoreOptions): Promise<LiveViewRows> {
  const result = await readLiveViewFn({
    data: { accessToken: await accessTokenOf(options), viewId },
  });
  return result;
}

/** Moves a view to manual/auto/live. Auto runs as YOU from now on; live is refused for spatial views. */
export async function setViewRefreshMode(
  viewId: string,
  mode: "manual" | "auto" | "live",
  options?: StoreOptions,
): Promise<void> {
  await setRefreshModeFn({ data: { accessToken: await accessTokenOf(options), viewId, mode } });
}

/** When the pending auto refresh becomes due (null = none queued). Editors and the creator only (RLS). */
export function refreshQueueQueryOptions(viewId: string, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:view_runs", "queue", viewId],
    queryFn: async (): Promise<{ dueAt: string; running: boolean } | null> => {
      const rows = await queryRows<{ dueAt: string; claimedAt: string | null }>(
        clientOf(options)
          .from("view_refresh_queue")
          .select("dueAt:due_at,claimedAt:claimed_at")
          .eq("view_id", viewId)
          .limit(1),
      );
      const first = rows[0];
      return first === undefined ? null : { dueAt: first.dueAt, running: first.claimedAt !== null };
    },
    refetchInterval: 10_000,
  });
}

/** The subset of `datasetIds` that are live views (the map's row path reads those through the live path). */
export function liveDatasetIdsQueryOptions(datasetIds: string[], options?: StoreOptions) {
  return queryOptions({
    // "liveIdList" (not "liveIds"): the old key persisted a Set as `{}`.
    queryKey: ["pg:datasets", "liveIdList", datasetIds.toSorted()],
    enabled: datasetIds.length > 0,
    // A plain array, never a Set: `pg:datasets` is a persisted light-state
    // namespace and the persister round-trips through JSON, so a Set comes
    // back as `{}` (`.has is not a function` on the next page load).
    queryFn: async (): Promise<string[]> => {
      const rows = await queryRows<{ id: string }>(
        clientOf(options)
          .from("datasets")
          .select("id")
          .in("id", datasetIds)
          .eq("refresh_mode", "live"),
      );
      return rows.map((row) => row.id);
    },
  });
}

/** The table page of a live view: the single capped read, searched/sorted here (there is no `search_entries` over rows that are not saved). */
export function liveSearchPageQueryOptions(args: SearchEntriesArgs, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:live", args.datasetId, "search", args.query, args.filters, args.sort],
    queryFn: async (): Promise<SearchEntriesPage> => {
      const live = await readLiveView(args.datasetId, options);
      return searchLiveEntries(liveRowsToEntries(args.datasetId, live.rows), args);
    },
  });
}

/** A live view's rows for the table/map: one capped server read, no page chain. */
export function liveViewRowsQueryOptions(viewId: string, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:live", viewId],
    queryFn: async () => await readLiveView(viewId, options),
  });
}

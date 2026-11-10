import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, throwPostgrestError, type StoreOptions } from "./client";
import { summaryOf, SUMMARY_SELECT } from "./datasets";
import type { DatasetSummaryRow, DatasetSummaryWire } from "./datasets";

/**
 * The read side of the views store for the catalog and the editor (#301).
 * Save and run live in `./views` (PostgREST RPCs and the server runner).
 * Every read here is an ordinary RLS-scoped query or invoker RPC, so an
 * unpublished project draft that the caller can see is a first-class input:
 * `view_input_meta` has no lifecycle gate (migration 0027).
 */

/** A view's catalog card: the dataset summary (refresh mode, stale flag, ...) plus its declared inputs. */
export interface ViewSummary extends DatasetSummaryRow {
  inputs: { alias: string; inputDatasetId: string }[];
}

interface ViewSummaryWire extends DatasetSummaryWire {
  inputs: { alias: string; inputDatasetId: string }[] | null;
}

/**
 * Every view the viewer can see (RLS), with its inputs. `stale` comes from
 * the `view_stale` computed column in the summary select. The embed names
 * its foreign key (`view_id`) because `view_inputs` also references
 * `datasets` through `input_dataset_id`.
 */
export function listViewSummariesQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:views", "summaries"],
    queryFn: async (): Promise<ViewSummary[]> => {
      const rows = await queryRows<ViewSummaryWire>(
        clientOf(options)
          .from("datasets")
          .select(
            `${SUMMARY_SELECT},inputs:view_inputs!view_id(alias,inputDatasetId:input_dataset_id)`,
          )
          .eq("kind", "view")
          .order("created_at", { ascending: false })
          .limit(500),
      );
      return rows.map((row) => ({ ...summaryOf(row), inputs: row.inputs ?? [] }));
    },
  });
}

/** The latest run of a view (editors and the creator only: run history is RLS-gated). */
export interface ViewLatestRun {
  viewId: string;
  status: "ok" | "error";
  finishedAt: string;
  rowCount: number | null;
  error: string | null;
}

/** The newest run per view, for the catalog cards. */
export function latestRunsQueryOptions(viewIds: string[], options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:view_runs", "latest", viewIds],
    enabled: viewIds.length > 0,
    queryFn: async (): Promise<globalThis.Map<string, ViewLatestRun>> => {
      const rows = await queryRows<ViewLatestRun>(
        clientOf(options)
          .from("view_runs")
          .select("viewId:view_id,status,finishedAt:finished_at,rowCount:row_count,error")
          .in("view_id", viewIds)
          .order("finished_at", { ascending: false })
          .limit(Math.max(50, viewIds.length * 3)),
      );
      const latest = new globalThis.Map<string, ViewLatestRun>();
      for (const row of rows) {
        if (!latest.has(row.viewId)) {
          latest.set(row.viewId, row);
        }
      }
      return latest;
    },
  });
}

/** The editor's header facts for one view. */
export interface ViewHeaderRow {
  id: string;
  title: string;
  description: string | null;
  kind: "source" | "view";
  lifecycle: "draft" | "published";
  refreshMode: "manual" | "auto" | "live" | null;
  stale: boolean;
  entryCount: number;
  dataVersion: number;
  createdBy: string;
}

export function viewHeaderQueryOptions(viewId: string, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:views", "header", viewId],
    queryFn: async () =>
      await queryRow<ViewHeaderRow>(
        clientOf(options)
          .from("datasets")
          .select(
            "id,title,description,kind,lifecycle,refreshMode:refresh_mode,stale:view_stale,entryCount:entry_count,dataVersion:data_version,createdBy:created_by",
          )
          .eq("id", viewId)
          .limit(1),
      ),
  });
}

/** The saved definition and its declared inputs (`view_definition`, an invoker RPC: RLS applies). */
export interface SavedViewDefinition {
  definition: unknown;
  refreshMode: "manual" | "auto" | "live";
  outputSettings: unknown;
  inputs: { alias: string; datasetId: string; pinnedVersion: string | null }[];
}

export function savedDefinitionQueryOptions(viewId: string, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:views", "definition", viewId],
    queryFn: async (): Promise<SavedViewDefinition | null> => {
      const { data, error } = await clientOf(options).rpc("view_definition", { p_view: viewId });
      if (error !== null) {
        throwPostgrestError(error);
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the RPC's documented jsonb shape (0027); null when the view is invisible.
      return data === null || data === undefined ? null : (data as SavedViewDefinition);
    },
  });
}

/** One declared input with its dataset title and declared field names (`view_input_meta`). A null title means the caller cannot see the input. */
export interface ViewInputMeta {
  alias: string;
  datasetId: string;
  pinnedVersion?: string | null;
  title: string | null;
  fields: string[];
}

export function inputMetaQueryOptions(
  inputs: { alias: string; datasetId: string; pinnedVersion?: string }[],
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:views", "inputMeta", inputs],
    enabled: inputs.length > 0,
    queryFn: async (): Promise<ViewInputMeta[]> => {
      const { data, error } = await clientOf(options).rpc("view_input_meta", { p_inputs: inputs });
      if (error !== null) {
        throwPostgrestError(error);
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the RPC's documented jsonb shape (0027).
      return Array.isArray(data) ? (data as ViewInputMeta[]) : [];
    },
  });
}

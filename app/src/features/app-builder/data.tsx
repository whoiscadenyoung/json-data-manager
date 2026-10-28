import { useAllPaginated } from "@caden/json-cms/react";
import { convexQuery } from "@convex-dev/react-query";
import { useQueries } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { entryDataRecord } from "#/lib/dataset-rows";
import { api } from "#convex/_generated/api";

import type { DataRecord } from "./lib/aggregate";
import { fieldsOfSchema, type DatasetField } from "./lib/fields";

/**
 * The app builder's data access — the ONE place the feature reads the rest
 * of the app's data APIs. Every read goes through the normal, auth-checked
 * dataset functions as the CURRENT viewer, so an app never shows anyone data
 * they couldn't open on its dataset page.
 */

export type DatasetDoc = NonNullable<FunctionReturnType<typeof api.cms.schemas.get>>;

export type DatasetState =
  | { status: "loading" }
  /** Deleted, or not visible to this viewer (a denial reads as missing — stage 8). */
  | { status: "unavailable" }
  | { status: "ready"; doc: DatasetDoc; fields: DatasetField[] };

const LOADING: DatasetState = { status: "loading" },
  UNAVAILABLE: DatasetState = { status: "unavailable" };

const AppDatasetsContext = createContext<ReadonlyMap<string, DatasetState>>(new Map());

/**
 * Resolves an app's data sources once for every widget beneath it: one
 * light schema-doc subscription per dataset (≤ 20, `APP_LIMITS.datasets`).
 * Errors are captured as query state rather than thrown (TanStack Query),
 * so one unavailable dataset degrades its widgets instead of the page.
 */
export function AppDatasetsProvider({
  datasetIds,
  children,
}: {
  datasetIds: readonly string[];
  children: ReactNode;
}) {
  const results = useQueries({
    queries: datasetIds.map((schemaId) => ({
      ...convexQuery(api.cms.schemas.get, { schemaId }),
      retry: false,
    })),
  });
  const states = new Map<string, DatasetState>(
    datasetIds.map((schemaId, index): [string, DatasetState] => {
      const result = results[index];
      if (result === undefined || result.isError) {
        return [schemaId, UNAVAILABLE];
      }
      if (result.data === undefined) {
        return [schemaId, LOADING];
      }
      if (result.data === null) {
        return [schemaId, UNAVAILABLE];
      }
      return [
        schemaId,
        { doc: result.data, fields: fieldsOfSchema(result.data.schema), status: "ready" },
      ];
    }),
  );
  return <AppDatasetsContext value={states}>{children}</AppDatasetsContext>;
}

export function useAppDatasets(): ReadonlyMap<string, DatasetState> {
  return useContext(AppDatasetsContext);
}

export function useAppDataset(datasetId: string): DatasetState {
  return useAppDatasets().get(datasetId) ?? UNAVAILABLE;
}

/** The dataset's title for labels, falling back gracefully while loading or when unavailable. */
export function datasetTitle(state: DatasetState): string {
  if (state.status === "ready") {
    return state.doc.title;
  }
  return state.status === "loading" ? "Loading…" : "Unavailable dataset";
}

/**
 * Every entry of one dataset as plain data records, live — the chart and
 * stat widgets aggregate over these. Reactive (the seam's `useAllPaginated`
 * bulk path), so an app's numbers update the moment its data changes.
 * `complete` is the real "every page loaded" signal (`Exhausted`).
 */
export function useDatasetRecords(schemaId: string): {
  records: DataRecord[];
  complete: boolean;
} {
  const { results, status } = useAllPaginated(api.cms.entries.listPage, { schemaId }),
    records = useMemo(() => results.map((row) => entryDataRecord(row)), [results]);
  return { complete: status === "Exhausted", records };
}

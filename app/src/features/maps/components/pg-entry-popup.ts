import { useQuery } from "@tanstack/react-query";

import type { DatasetEntryRow } from "#/lib/dataset-rows";
import type { FeatureSelection } from "#/lib/dataset-rows-react";
import { getQueryOptions } from "#/lib/store/entries";

import { pgEntryToEntryRow } from "./pg-layer-rows";

/**
 * The popup executor's POSTGRES point-read (issue #52's pattern): one
 * indexed single-entry read through the entries store, live only while the
 * caller holds it with a selection. Views are real datasets with saved rows
 * (#301), so a clicked feature reads exactly as stored; the derived-spec
 * enrichment this hook once folded on retired with the derived registry.
 *
 * `joinedPending` is always false and `loaders` empty: the shape matches
 * `useEnrichedDatasetEntryRow` so LayersMap's popup consumer stays one
 * branch on the clicked dataset's ORIGIN (`isPostgresDatasetId`), with both
 * hooks mounted and exactly one live.
 */

/** The clicked entry; `null` when the entry is gone (RLS-invisible or deleted mid-click). */
export function usePgEnrichedDatasetEntryRow(selected: FeatureSelection | undefined): {
  /** The seam-shaped row the popup panel reads (`_id`/`data`/`schemaId`). */
  entry: DatasetEntryRow | null | undefined;
  joinedPending: boolean;
  loaders: React.ReactNode[];
} {
  const entryId = selected === undefined ? undefined : selected.entryId,
    entry = useQuery({
      ...getQueryOptions({ entryId: entryId ?? "" }),
      enabled: entryId !== undefined,
    }),
    base = entry.data;
  return {
    entry: base === undefined || base === null ? base : pgEntryToEntryRow(base),
    joinedPending: false,
    loaders: [],
  };
}

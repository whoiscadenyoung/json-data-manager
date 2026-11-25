import { useQuery } from "@tanstack/react-query";

import type { FeatureSelection } from "#/lib/dataset-rows";
import { getQueryOptions, type EntryRow } from "#/lib/store/entries";
import { versionEntryQueryOptions } from "#/lib/store/versions";
import { liveViewRowsQueryOptions } from "#/lib/store/views";
import { liveRowByEntryId } from "#/lib/views/live-rows";

/**
 * The popup executor's point-read (issue #52's pattern): one indexed
 * single-entry read through the entries store, live only while the caller
 * holds it with a selection. Views are real datasets with saved rows (#301),
 * so a clicked feature reads exactly as stored; the derived-spec enrichment
 * this hook once folded on retired with the derived registry.
 *
 * `joinedPending` is always false and `loaders` empty: the shape matches
 * `useEnrichedDatasetEntryRow` so LayersMap's popup consumer stays one
 * branch on the clicked render id (a frozen version → the snapshot read; a
 * live view → the shared live read; else the plain point read), with all
 * three hooks mounted and exactly one live.
 */

/** A frozen/live row synthesized as a full store row: the popup panel reads `data`; the inert fields keep one row type everywhere. */
function popupRowOf(data: unknown, selected: FeatureSelection): EntryRow {
  return {
    createdAt: "",
    data,
    datasetId: selected.datasetId,
    geometryType: null,
    id: selected.entryId,
  };
}

/** The clicked entry; `null` when the entry is gone (RLS-invisible or deleted mid-click). */
export function useEnrichedDatasetEntryRow(selected: FeatureSelection | undefined): {
  /** The store's entry row, exactly as the point read handed it back. */
  entry: EntryRow | null | undefined;
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
    entry: base,
    joinedPending: false,
    loaders: [],
  };
}

/**
 * The popup point read over the FROZEN rows (issue #330): published apps'
 * map popups run signed-out, and the live entries read denies anon
 * ("This entry no longer exists"). Reads `version_entries` by (version,
 * entry) — anon-readable through the version's dataset visibility — with
 * the same row shape as the live hook, so LayersMap stays one branch on
 * whether the clicked render id carries a frozen version.
 */
export function useFrozenVersionEntryRow(args: {
  selected: FeatureSelection | undefined;
  versionByDatasetId: ReadonlyMap<string, string>;
}): {
  entry: EntryRow | null | undefined;
  joinedPending: boolean;
  loaders: React.ReactNode[];
} {
  const selected = args.selected,
    versionId =
      selected === undefined ? undefined : args.versionByDatasetId.get(selected.datasetId),
    entry = useQuery({
      ...versionEntryQueryOptions({
        entryId: selected === undefined ? "" : selected.entryId,
        versionId: versionId === undefined ? "" : versionId,
      }),
      enabled: selected !== undefined && versionId !== undefined,
    }),
    base = entry.data;
  return {
    entry:
      base === undefined || base === null || selected === undefined
        ? base === null
          ? null
          : undefined
        : // Provenance-severed rows carry a null entry id; the click
          // payload's id still names the panel's subject.
          popupRowOf(base.data, selected),
    joinedPending: false,
    loaders: [],
  };
}

/**
 * The popup executor for a LIVE view's rows (#331): a live row has no saved
 * entry, so the point reads above find nothing and the popup never resolves.
 * Reads the SAME capped server read the loader and table use (one shared
 * query cache entry — no extra fetch) and resolves the row by its derived
 * live id.
 */
export function useLiveViewEntryRow(args: {
  selected: FeatureSelection | undefined;
  liveDatasetIds: ReadonlySet<string>;
}): {
  entry: EntryRow | null | undefined;
  joinedPending: boolean;
  loaders: React.ReactNode[];
} {
  const selected = args.selected,
    isLive = selected !== undefined && args.liveDatasetIds.has(selected.datasetId),
    read = useQuery({
      ...liveViewRowsQueryOptions(selected === undefined ? "" : selected.datasetId),
      enabled: isLive,
    });
  if (selected === undefined || !isLive) {
    return { entry: undefined, joinedPending: false, loaders: [] };
  }
  const live = read.data;
  if (live === undefined) {
    return { entry: read.isError ? null : undefined, joinedPending: false, loaders: [] };
  }
  const row = liveRowByEntryId(live.rows, selected.entryId);
  return {
    entry: row === undefined ? null : popupRowOf(row.data, selected),
    joinedPending: false,
    loaders: [],
  };
}

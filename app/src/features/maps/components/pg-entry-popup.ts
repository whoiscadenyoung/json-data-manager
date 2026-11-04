import { useQuery } from "@tanstack/react-query";

import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { applyEntryRowSpec } from "#/lib/dataset-rows-pg";
import type { FeatureSelection } from "#/lib/dataset-rows-react";
import { getQueryOptions } from "#/lib/store/entries";

import { pgEntryToEntryRow } from "./pg-layer-rows";

/**
 * The popup executor's POSTGRES point-read (issue #52's pattern, #97's
 * spec pass — design §8.3's "point-read half"): one indexed single-entry
 * read through the entries store, live only while the caller holds it with
 * a selection, folded through the seam's `applyEntryRowSpec` — the SAME
 * pinned-enrichment step the Convex popup executor runs, so the popup
 * semantics cannot drift between backends.
 *
 * Where the specs come from: the Convex executor streams the SAVED,
 * read-time-healthy derived-dataset specs targeting the clicked dataset
 * (`api.versions.derivedDatasets.listBySource`). Postgres has no derived
 * registry until stage 4's `derived_datasets` (stage 5 wires the
 * shortlist), so a PG dataset's spec list is EMPTY today and the pass is
 * the documented identity — the call site below is where stage 5 plugs the
 * PG shortlist in, with the lookup-row fan-out riding the same
 * `lookupRowsByDataset` parameter.
 *
 * `joinedPending` is therefore always false and `loaders` empty for now —
 * the shape matches `useEnrichedDatasetEntryRow` so LayersMap's popup
 * consumer stays one branch on the clicked dataset's ORIGIN
 * (`isPostgresDatasetId`), with both hooks mounted and exactly one live.
 */

/** The clicked entry with its saved specs folded on — `null` when the entry is gone (RLS-invisible or deleted mid-click). */
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
    // Stage 5 plugs the PG derived-spec shortlist (and its lookup-row
    // loader components) in HERE — the pass itself is already the seam's.
    specs: readonly unknown[] = [],
    lookupRowsByDataset: ReadonlyMap<string, readonly Record<string, unknown>[]> = new Map(),
    base = entry.data;
  return {
    entry:
      base === undefined || base === null
        ? base
        : // The spec pass runs on the STORE row (its native shape), then the
          // result lifts into the seam row the panel reads.
          pgEntryToEntryRow(applyEntryRowSpec(base, specs, lookupRowsByDataset)),
    joinedPending: false,
    loaders: [],
  };
}

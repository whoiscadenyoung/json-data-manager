import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRows, type StoreOptions } from "./client";

/**
 * The references store (design doc §8.1 "references.ts # reverse lookup
 * reads") — the `entry_references` table (DDL §3.2) as the entry-details
 * surface reads it. The rows themselves are trigger-owned (the
 * `entry_refs_sync` trigger derives them from every entry's reference fields
 * on write — the component's delete-and-rederive parity, §3.2), so this
 * module is reads only: no client ever writes a reference row directly, and
 * the design's policy matrix grants no direct writes either.
 */

/** One reverse-reference hit: `entryId`'s incoming link from another entry. */
export interface ReferencingEntryRow {
  sourceEntryId: string;
  sourceDatasetId: string;
  fieldName: string;
}

/**
 * The entries that reference `entryId`, with the field that carries the link
 * — `api.cms.entries.listReferencingEntries` parity over the PG table (the
 * `entry_refs_by_target_entry` index serves it). RLS reads rows where either
 * side is viewable (§4), so an invisible source simply doesn't appear.
 */
export async function listReferencingEntries(
  args: { entryId: string },
  options?: StoreOptions,
): Promise<ReferencingEntryRow[]> {
  return await queryRows<ReferencingEntryRow>(
    clientOf(options)
      .from("entry_references")
      .select(
        "sourceEntryId:source_entry_id,sourceDatasetId:source_dataset_id,fieldName:field_name",
      )
      .eq("target_entry_id", args.entryId)
      .limit(200),
  );
}

export function listReferencingEntriesQueryOptions(
  args: { entryId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:references", "listReferencingEntries", args],
    queryFn: async () => await listReferencingEntries(args, options),
  });
}

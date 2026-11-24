import type { ReferenceField } from "@caden/json-cms/react";
import { useQuery } from "@tanstack/react-query";

import * as entriesStore from "@/lib/store/entries";

import { buildLabelsByField, isRecord, referencedEntryIds } from "./reference-labels";

/**
 * The reference-field label lookup (design §14.6): reference fields name
 * their TARGET dataset, and the store's batched `listForIds` serves the
 * labels (one query per surface, never per link). The result is the `labelsByField` map the shared
 * table/entry-details renderers consume.
 *
 * Cap note: the id list is capped at the store's `LIST_FOR_IDS_MAX` (the
 * documented bound) — links beyond the cap render their raw id.
 */
export function useReferenceLabels(
  referenceFields: ReferenceField[],
  entries: ReadonlyArray<{ data: unknown }>,
): Map<string, Map<string, string>> {
  const pgIds = new Set<string>();
  if (referenceFields.length > 0) {
    for (const entry of entries) {
      const record = isRecord(entry.data) ? entry.data : {};
      for (const field of referenceFields) {
        for (const id of referencedEntryIds(record[field.name])) {
          pgIds.add(id);
        }
      }
    }
  }
  const cappedIds = [...pgIds].slice(0, entriesStore.LIST_FOR_IDS_MAX),
    pgLabels = useQuery({
      ...entriesStore.listForIdsQueryOptions({ entryIds: cappedIds }),
      enabled: cappedIds.length > 0,
    });

  return buildLabelsByField(
    referenceFields,
    (pgLabels.data ?? []).map((row) => ({
      _id: row.id,
      data: row.data,
      schemaId: row.datasetId,
    })),
  );
}

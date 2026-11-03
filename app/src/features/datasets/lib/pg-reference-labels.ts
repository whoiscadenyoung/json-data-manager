import type { ReferenceField } from "@caden/json-cms/react";
import { useQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";

import { api } from "#convex/_generated/api";
import { isPostgresDatasetId } from "@/lib/dataset-source";
import * as entriesStore from "@/lib/store/entries";

import { buildLabelsByField, isRecord, referencedEntryIds } from "./reference-labels";

/**
 * The split-brain label lookup (design §14.6): reference fields name their
 * TARGET dataset, and the target's backend — not the current surface's —
 * serves the labels. Rows referenced by a Postgres dataset ride the store's
 * batched `listForIds` (one query per backend, never per link); targets on
 * the Convex backend keep the component's `listForIds` query. Both halves
 * merge into the same `labelsByField` map the shared table/entry-details
 * renderers consume.
 *
 * Cap note: each backend's id list is capped at the store's
 * `LIST_FOR_IDS_MAX` (the component read's documented bound) — links beyond
 * the cap render their raw id, exactly as the Convex page documents.
 */
export function useSplitReferenceLabels(
  referenceFields: ReferenceField[],
  entries: ReadonlyArray<{ data: unknown }>,
): Map<string, Map<string, string>> {
  const idsByBackend = { convex: new Set<string>(), pg: new Set<string>() };
  if (referenceFields.length > 0) {
    for (const entry of entries) {
      const record = isRecord(entry.data) ? entry.data : {};
      for (const field of referenceFields) {
        for (const id of referencedEntryIds(record[field.name])) {
          if (isPostgresDatasetId(field.meta.datasetId)) {
            idsByBackend.pg.add(id);
          } else {
            idsByBackend.convex.add(id);
          }
        }
      }
    }
  }
  const pgIds = [...idsByBackend.pg].slice(0, entriesStore.LIST_FOR_IDS_MAX),
    convexIds = [...idsByBackend.convex].slice(0, entriesStore.LIST_FOR_IDS_MAX),
    pgLabels = useQuery({
      ...entriesStore.listForIdsQueryOptions({ entryIds: pgIds }),
      enabled: pgIds.length > 0,
    }),
    convexLabels = useConvexQuery(
      api.cms.entries.listForIds,
      convexIds.length > 0 ? { entryIds: convexIds } : "skip",
    );

  return buildLabelsByField(referenceFields, [
    ...(pgLabels.data ?? []).map((row) => ({
      _id: row.id,
      data: row.data,
      schemaId: row.datasetId,
    })),
    ...(convexLabels ?? []),
  ]);
}

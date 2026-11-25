import type { ReferenceField } from "@caden/json-cms/react";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves each reference field's target entry ids to a display label (its
 * `displayProperty`, when the target entry has one), grouped by field name.
 * `candidateEntries` is the label-lookup rows for every dataset any of
 * `referenceFields` points at — see `entries-table.tsx` and `entry-details.tsx`.
 */
export function buildLabelsByField(
  referenceFields: ReferenceField[],
  candidateEntries: Array<{ _id: string; datasetId: string; data: unknown }>,
): Map<string, Map<string, string>> {
  const entriesBySchema = new Map<string, Array<{ _id: string; data: unknown }>>();
  for (const entry of candidateEntries) {
    const list = entriesBySchema.get(entry.datasetId) ?? [];
    list.push(entry);
    entriesBySchema.set(entry.datasetId, list);
  }

  const labelsByField = new Map<string, Map<string, string>>();
  for (const field of referenceFields) {
    const targetEntries = entriesBySchema.get(field.meta.datasetId) ?? [],
      labels = new Map<string, string>();
    for (const entry of targetEntries) {
      const raw =
        field.meta.displayProperty && isRecord(entry.data)
          ? entry.data[field.meta.displayProperty]
          : undefined;
      if (typeof raw === "string" && raw.length > 0) {
        labels.set(entry._id, raw);
      }
    }
    labelsByField.set(field.name, labels);
  }
  return labelsByField;
}

/** The referenced entry id(s) held by a single field's raw value, regardless of cardinality. */
export function referencedEntryIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

/** Upper bound on ids sent to a batched label lookup (the component's read rejects more); links beyond the cap render their raw id as today. */
export const LABEL_IDS_CAP = 200;

/**
 * Collects the union of entry ids the given rows reference across all
 * reference fields — exactly the entries whose labels are worth fetching.
 * Used to be "every row of every referenced dataset" via
 * `listEntriesForSchemas`, which quietly loaded whole other datasets just to
 * label a handful of links (issue #54). Used by the table host to look the labels up.
 */
export function collectReferencedIds(
  entries: ReadonlyArray<{ data: unknown }>,
  referenceFields: ReferenceField[],
): string[] {
  const ids = new Set<string>();
  if (referenceFields.length === 0) {
    return [];
  }
  for (const entry of entries) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `data` is `v.any()` in the component schema; reference values were validated at write time.
    const data = entry.data as Record<string, unknown>;
    for (const field of referenceFields) {
      for (const id of referencedEntryIds(data[field.name])) {
        ids.add(id);
      }
    }
  }
  return [...ids].slice(0, LABEL_IDS_CAP);
}

// --- the reactive lookup (the store's batched read, one query per surface) ---

import { useQuery } from "@tanstack/react-query";

import * as entriesStore from "@/lib/store/entries";

/**
 * The reference-field label lookup (design §14.6): reference fields name
 * their TARGET dataset, and the store's batched `listForIds` serves the
 * labels (one query per surface, never per link). The result is the
 * `labelsByField` map the shared table/entry-details renderers consume.
 *
 * Cap note: the id list is capped at the store's `LIST_FOR_IDS_MAX` (the
 * documented bound) — links beyond the cap render their raw id.
 */
export function useReferenceLabels(
  referenceFields: ReferenceField[],
  entries: ReadonlyArray<{ data: unknown }>,
): Map<string, Map<string, string>> {
  const ids = new Set<string>();
  if (referenceFields.length > 0) {
    for (const entry of entries) {
      const record = isRecord(entry.data) ? entry.data : {};
      for (const field of referenceFields) {
        for (const id of referencedEntryIds(record[field.name])) {
          ids.add(id);
        }
      }
    }
  }
  const cappedIds = [...ids].slice(0, entriesStore.LIST_FOR_IDS_MAX),
    labels = useQuery({
      ...entriesStore.listForIdsQueryOptions({ entryIds: cappedIds }),
      enabled: cappedIds.length > 0,
    });

  return buildLabelsByField(
    referenceFields,
    (labels.data ?? []).map((row) => ({
      _id: row.id,
      data: row.data,
      datasetId: row.datasetId,
    })),
  );
}

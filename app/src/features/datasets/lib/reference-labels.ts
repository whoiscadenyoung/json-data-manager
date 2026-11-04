import type { ReferenceField } from "@caden/json-cms/react";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves each reference field's target entry ids to a display label (its
 * `displayProperty`, when the target entry has one), grouped by field name.
 * `candidateEntries` is expected to be the flattened result of one
 * `api.cms.entries.listEntriesForSchemas` call covering every dataset any of
 * `referenceFields` points at — see `entries-table.tsx` and `$entryId.tsx`.
 */
export function buildLabelsByField(
  referenceFields: ReferenceField[],
  candidateEntries: Array<{ _id: string; schemaId: string; data: unknown }>,
): Map<string, Map<string, string>> {
  const entriesBySchema = new Map<string, Array<{ _id: string; data: unknown }>>();
  for (const entry of candidateEntries) {
    const list = entriesBySchema.get(entry.schemaId) ?? [];
    list.push(entry);
    entriesBySchema.set(entry.schemaId, list);
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
 * label a handful of links (issue #54). Shared by the entries table (Convex
 * mode) and the Postgres table host, which splits the result per backend
 * before looking the labels up.
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

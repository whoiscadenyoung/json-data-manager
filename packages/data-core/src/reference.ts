/**
 * Foreign-reference fields let one dataset's entries point at entries in
 * another dataset (e.g. a "deployments" entry's `state` field pointing at a
 * `states` entry) — a relational link layered on top of the JSON Schema
 * storage model.
 *
 * A reference field is an ordinary `string` (single) or `array` of `string`
 * (many) JSON Schema property, annotated with the custom `"x-reference"`
 * keyword. JSON Schema validators ignore unknown keywords, so this is a
 * fully backward-compatible extension: nothing else in the pipeline (AJV
 * validation, import, export) needs to know it exists. The stored string
 * value(s) are the referenced entry's id(s).
 */

/** The custom JSON Schema keyword a reference field is annotated with. */
export const REFERENCE_KEYWORD = "x-reference";

export interface ReferenceMeta {
  /** The target dataset's schema id. */
  datasetId: string;
  /** Top-level property of the target entry's `data` to show as a label. Falls back to the raw entry id when unset. */
  displayProperty?: string;
  /** "one": the field stores a single entry id (or null). "many": the field stores an array of entry ids. */
  cardinality: "one" | "many";
}

export interface ReferenceField {
  /** The top-level property name on the source entry's `data` holding the reference(s). */
  name: string;
  meta: ReferenceMeta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReferenceMeta(value: unknown): value is ReferenceMeta {
  return (
    isRecord(value) &&
    typeof value.datasetId === "string" &&
    value.datasetId.length > 0 &&
    (value.cardinality === "one" || value.cardinality === "many") &&
    (value.displayProperty === undefined || typeof value.displayProperty === "string")
  );
}

/**
 * Scans a JSON Schema object's top-level `properties` for ones annotated
 * with `x-reference` and returns them. Only top-level properties are
 * considered — a reference nested inside an object/array item isn't
 * discovered (and isn't indexed), keeping extraction a cheap, predictable
 * single pass over `data`.
 */
export function getReferenceFields(schema: unknown): ReferenceField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }
  const fields: ReferenceField[] = [];
  for (const [name, propSchema] of Object.entries(schema.properties)) {
    if (isRecord(propSchema) && isReferenceMeta(propSchema[REFERENCE_KEYWORD])) {
      fields.push({ meta: propSchema[REFERENCE_KEYWORD], name });
    }
  }
  return fields;
}

/** Pulls the referenced entry id(s) out of a single field's raw value, per its cardinality. */
export function extractReferenceIds(meta: ReferenceMeta, value: unknown): string[] {
  if (meta.cardinality === "many") {
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

export interface ExtractedReference {
  fieldName: string;
  targetSchemaId: string;
  targetEntryId: string;
}

/** One selectable target entry for a reference field's picker widget. */
export interface ReferenceCandidate {
  /** The target entry's id — the value actually stored in `data`. */
  value: string;
  /** The target entry's resolved display label (its `displayProperty`, or the raw id as a fallback). */
  label: string;
}

/** Every outgoing reference an entry's `data` currently carries, per its schema's reference fields. */
export function extractReferences(schema: unknown, data: unknown): ExtractedReference[] {
  if (!isRecord(data)) {
    return [];
  }
  const refs: ExtractedReference[] = [];
  for (const field of getReferenceFields(schema)) {
    for (const targetEntryId of extractReferenceIds(field.meta, data[field.name])) {
      refs.push({ fieldName: field.name, targetEntryId, targetSchemaId: field.meta.datasetId });
    }
  }
  return refs;
}

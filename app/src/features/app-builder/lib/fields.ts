/**
 * Field discovery from a dataset's JSON Schema — the builder's column,
 * group-by and value pickers. Pure, React-free.
 */

export interface DatasetField {
  name: string;
  /** The declared JSON Schema type (first of a union), or "unknown". */
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredType(property: unknown): string {
  if (!isRecord(property)) {
    return "unknown";
  }
  const { type } = property;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    const first = type.find((entry) => typeof entry === "string" && entry !== "null");
    return typeof first === "string" ? first : "unknown";
  }
  return "unknown";
}

/** The dataset's top-level fields in declared order. */
export function fieldsOfSchema(schema: unknown): DatasetField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    type: declaredType(property),
  }));
}

/** Fields a sum/average can read. Imported CSV columns are often declared strings, so callers may fall back to every field. */
export function numericFields(fields: readonly DatasetField[]): DatasetField[] {
  return fields.filter((field) => field.type === "number" || field.type === "integer");
}

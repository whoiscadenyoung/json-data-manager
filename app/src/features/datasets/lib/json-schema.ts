/** Minimal shape of the JSON Schema subset this app reads for display purposes. */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  required?: string[];
  enum?: unknown[];
  format?: string;
  description?: string;
  title?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
}

export function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null;
}

/** The JSON Schema `type` keyword, falling back to "object" when properties are present, else "any". */
export function schemaType(schema: unknown): string {
  if (!isSchemaNode(schema)) {
    return "any";
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }
  return schema.properties ? "object" : "any";
}

/** Number of top-level properties defined on a schema's `properties`, or 0 if none. */
export function fieldCount(schema: unknown): number {
  if (!isSchemaNode(schema) || !isSchemaNode(schema.properties)) {
    return 0;
  }
  return Object.keys(schema.properties).length;
}

/** The filter type of one declared property: number, boolean, or everything else as string. */
export type DeclaredPropertyType = "boolean" | "number" | "string";

/**
 * The filter type of each declared property, read from the stored JSON
 * Schema's `properties[name].type` (`["string", "null"]` unions read as their
 * base type). Drives the PG table's server-mode filter controls and the
 * `search_entries` filter-value coercion (§5.1's `eq` is jsonb containment,
 * so a numeric column must be filtered by a NUMBER — its text "5" matches
 * nothing).
 */
export function declaredPropertyTypes(schema: unknown): Map<string, DeclaredPropertyType> {
  const types = new Map<string, DeclaredPropertyType>();
  if (!isSchemaNode(schema) || !isSchemaNode(schema.properties)) {
    return types;
  }
  for (const [name, raw] of Object.entries(schema.properties)) {
    const node = isSchemaNode(raw) ? raw : {},
      base = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
    if (base === "number" || base === "integer") {
      types.set(name, "number");
    } else if (base === "boolean") {
      types.set(name, "boolean");
    } else {
      types.set(name, "string");
    }
  }
  return types;
}

/**
 * A single field, parsed out of a JSON Schema `properties` entry into the same
 * shape the visual schema builder edits — so the read-only viewer and the
 * create/edit builder describe a field with the same vocabulary.
 */
export interface ParsedProperty {
  name: string;
  type: string;
  nullable: boolean;
  required: boolean;
  title?: string;
  description?: string;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enumValues?: unknown[];
  /** Base type of array items, when `type` is "array". */
  itemType?: string;
  minItems?: number;
  maxItems?: number;
  /** Nested fields, for an "object" field or the item schema of an array of objects. */
  properties?: ParsedProperty[];
}

/** Split a possibly-nullable JSON-Schema `type` (e.g. `["string", "null"]`) into a base type + flag. */
function parseTypeInfo(rawType: JsonSchemaNode["type"]): { type: string; nullable: boolean } {
  if (Array.isArray(rawType)) {
    const base = rawType.find((t) => t !== "null");
    return { nullable: rawType.includes("null"), type: base ?? "any" };
  }
  return { nullable: false, type: rawType ?? "any" };
}

interface NestedInfo {
  itemType?: string;
  nestedProperties?: Record<string, unknown>;
  nestedRequired?: string[];
}

/** Resolve an object field's nested properties, or an array field's item type + nested properties. */
function resolveNested(schema: JsonSchemaNode, type: string): NestedInfo {
  if (type === "object") {
    return { nestedProperties: schema.properties, nestedRequired: schema.required };
  }
  if (type !== "array") {
    return {};
  }
  const rawItemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items,
    itemSchema = isSchemaNode(rawItemSchema) ? rawItemSchema : undefined;
  if (!itemSchema) {
    return {};
  }
  const itemType = parseTypeInfo(itemSchema.type).type;
  return {
    itemType,
    nestedProperties: itemType === "object" ? itemSchema.properties : undefined,
    nestedRequired: itemSchema.required,
  };
}

function parseProperty(name: string, raw: unknown, required: Set<string>): ParsedProperty {
  const schema = isSchemaNode(raw) ? raw : {},
    { type, nullable } = parseTypeInfo(schema.type),
    { itemType, nestedProperties, nestedRequired } = resolveNested(schema, type);

  return {
    description: schema.description,
    enumValues: schema.enum,
    format: schema.format,
    itemType,
    maxItems: schema.maxItems,
    maxLength: schema.maxLength,
    maximum: schema.maximum,
    minItems: schema.minItems,
    minLength: schema.minLength,
    minimum: schema.minimum,
    multipleOf: schema.multipleOf,
    name,
    nullable,
    pattern: schema.pattern,
    properties: nestedProperties
      ? parseSchemaProperties(nestedProperties, nestedRequired)
      : undefined,
    required: required.has(name),
    title: schema.title,
    type,
  };
}

/** Parse a schema's `properties` map (plus `required` list) into display-ready fields. */
export function parseSchemaProperties(
  properties: Record<string, unknown> | undefined,
  required: string[] | undefined,
): ParsedProperty[] {
  if (!properties) {
    return [];
  }
  const requiredSet = new Set(required ?? []);
  return Object.entries(properties).map(([name, raw]) => parseProperty(name, raw, requiredSet));
}

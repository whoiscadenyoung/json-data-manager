type InferredType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "mixed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferType(value: unknown): InferredType {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  return "string";
}

function mergeTypes(a: InferredType, b: InferredType): InferredType {
  if (a === b) {
    return a;
  }
  if (a === "null") {
    return b;
  }
  if (b === "null") {
    return a;
  }
  // Integer + number → number
  if ((a === "integer" && b === "number") || (a === "number" && b === "integer")) {
    return "number";
  }
  return "mixed";
}

interface ColumnScan {
  inferredType: InferredType;
  presentCount: number;
  /**
   * Track null separately from the non-null type inference so a column that is
   * null in some rows and a concrete type in others produces a nullable schema
   * (e.g. `["string", "null"]`) that stays valid against every row.
   */
  sawNull: boolean;
  subObjects: Record<string, unknown>[];
  arrayValues: unknown[][];
}

/** Scan one key across all objects, gathering the info needed to type it. */
function scanColumn(objects: Record<string, unknown>[], key: string): ColumnScan {
  let inferredType: InferredType = "null",
    presentCount = 0,
    sawNull = false;
  const subObjects: Record<string, unknown>[] = [],
    arrayValues: unknown[][] = [];

  for (const obj of objects) {
    if (!(key in obj) || obj[key] === undefined) {
      continue;
    }
    const value = obj[key];
    if (value === null) {
      sawNull = true;
      continue;
    }
    presentCount += 1;
    const t = inferType(value);
    inferredType = mergeTypes(inferredType, t);
    if (t === "object" && isRecord(value)) {
      subObjects.push(value);
    }
    if (t === "array" && Array.isArray(value)) {
      arrayValues.push(value);
    }
  }

  return { arrayValues, inferredType, presentCount, sawNull, subObjects };
}

/** Infer the `items` schema for an array column, or undefined if unconstrained. */
function buildArrayItems(arrayValues: unknown[][]): Record<string, unknown> | undefined {
  const flatItems = arrayValues.flat();
  if (flatItems.length === 0) {
    return undefined;
  }
  let itemType: InferredType = "null",
    itemsSawNull = false;
  for (const item of flatItems) {
    if (item === null) {
      itemsSawNull = true;
      continue;
    }
    itemType = mergeTypes(itemType, inferType(item));
  }
  if (itemType === "mixed" || itemType === "null") {
    return undefined;
  }
  return { type: itemsSawNull ? [itemType, "null"] : itemType };
}

/** Build the JSON-Schema fragment for a single property. */
function inferPropertySchema(
  objects: Record<string, unknown>[],
  key: string,
): { schema: Record<string, unknown>; requiredInAll: boolean } {
  const { inferredType, presentCount, sawNull, subObjects, arrayValues } = scanColumn(objects, key);
  let schema: Record<string, unknown> = {};

  if (inferredType !== "mixed" && inferredType !== "null") {
    // A concrete type gets a nullable union when null was also observed.
    const asType = (t: string): string | string[] => (sawNull ? [t, "null"] : t);

    if (inferredType === "object" && subObjects.length > 0) {
      schema = inferObjectSchema(subObjects);
      schema.type = asType("object");
    } else if (inferredType === "array") {
      schema = { type: asType("array") };
      const items = buildArrayItems(arrayValues);
      if (items) {
        schema.items = items;
      }
    } else {
      schema = { type: asType(inferredType) };
    }
  }

  // A field is required only if present (non-null) in every object. A field that
  // is null in some rows stays optional — its nullable type allows the nulls.
  return { requiredInAll: presentCount === objects.length, schema };
}

function inferObjectSchema(objects: Record<string, unknown>[]): Record<string, unknown> {
  if (objects.length === 0) {
    return { description: "", properties: {}, required: [], title: "", type: "object" };
  }

  const allKeys = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      allKeys.add(key);
    }
  }

  const properties: Record<string, unknown> = {},
    required: string[] = [];

  for (const key of allKeys) {
    const { schema, requiredInAll } = inferPropertySchema(objects, key);
    properties[key] = schema;
    if (requiredInAll) {
      required.push(key);
    }
  }

  return {
    description: "",
    properties,
    title: "",
    type: "object",
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Infer a JSON Schema Draft-07 object from an array of plain objects.
 * The resulting schema will have empty title and description that the user
 * should fill in before saving.
 */
export function inferSchemaFromData(data: unknown[]): Record<string, unknown> {
  const objects = data.filter(isRecord);

  if (objects.length === 0) {
    return {
      description: "",
      properties: {},
      title: "",
      type: "object",
    };
  }

  return inferObjectSchema(objects);
}

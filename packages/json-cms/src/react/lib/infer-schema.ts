type InferredType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "mixed";

function inferType(value: unknown): InferredType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "string";
}

function mergeTypes(a: InferredType, b: InferredType): InferredType {
  if (a === b) return a;
  if (a === "null") return b;
  if (b === "null") return a;
  // integer + number → number
  if ((a === "integer" && b === "number") || (a === "number" && b === "integer")) return "number";
  return "mixed";
}

function inferObjectSchema(objects: Record<string, unknown>[]): Record<string, unknown> {
  if (objects.length === 0) {
    return { type: "object", title: "", description: "", properties: {}, required: [] };
  }

  // Collect all keys
  const allKeys = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      allKeys.add(key);
    }
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const key of allKeys) {
    // Determine the inferred type across all objects
    let inferredType: InferredType = "null";
    let presentCount = 0;
    const subObjects: Record<string, unknown>[] = [];
    const arrayValues: unknown[][] = [];

    for (const obj of objects) {
      if (key in obj && obj[key] !== undefined && obj[key] !== null) {
        presentCount++;
        const t = inferType(obj[key]);
        inferredType = mergeTypes(inferredType, t);
        if (t === "object" && obj[key] !== null) {
          subObjects.push(obj[key] as Record<string, unknown>);
        }
        if (t === "array" && Array.isArray(obj[key])) {
          arrayValues.push(obj[key] as unknown[]);
        }
      }
    }

    // Build the property schema
    let propSchema: Record<string, unknown> = {};

    if (inferredType !== "mixed" && inferredType !== "null") {
      if (inferredType === "object" && subObjects.length > 0) {
        const nested = inferObjectSchema(subObjects);
        propSchema = nested;
        // Override type explicitly
        propSchema.type = "object";
      } else if (inferredType === "array") {
        propSchema = { type: "array" };
        // Try to infer item type from all array values
        const flatItems = arrayValues.flat();
        if (flatItems.length > 0) {
          let itemType: InferredType = "null";
          for (const item of flatItems) {
            itemType = mergeTypes(itemType, inferType(item));
          }
          if (itemType !== "mixed" && itemType !== "null") {
            propSchema.items = { type: itemType };
          }
        }
      } else {
        propSchema = { type: inferredType };
      }
    }

    properties[key] = propSchema;

    // Mark as required if present in all objects and never null
    if (presentCount === objects.length) {
      required.push(key);
    }
  }

  return {
    type: "object",
    title: "",
    description: "",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Infer a JSON Schema Draft-07 object from an array of plain objects.
 * The resulting schema will have empty title and description that the user
 * should fill in before saving.
 */
export function inferSchemaFromData(data: unknown[]): Record<string, unknown> {
  const objects = data.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );

  if (objects.length === 0) {
    return {
      type: "object",
      title: "",
      description: "",
      properties: {},
    };
  }

  return inferObjectSchema(objects);
}

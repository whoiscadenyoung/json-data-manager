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

function inferObjectSchema(objects: Record<string, unknown>[]): Record<string, unknown> {
  if (objects.length === 0) {
    return { description: "", properties: {}, required: [], title: "", type: "object" };
  }

  // Collect all keys
  const allKeys = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      allKeys.add(key);
    }
  }

  const properties: Record<string, unknown> = {},
    required: string[] = [];

  for (const key of allKeys) {
    // Determine the inferred type across all objects
    let inferredType: InferredType = "null",
      presentCount = 0,
      // Track null separately from the non-null type inference so a column that
      // Is null in some rows and a concrete type in others produces a nullable
      // Schema (e.g. `["string", "null"]`) that stays valid against every row.
      sawNull = false;
    const subObjects: Record<string, unknown>[] = [],
      arrayValues: unknown[][] = [];

    for (const obj of objects) {
      if (!(key in obj) || obj[key] === undefined) {
        continue;
      }
      if (obj[key] === null) {
        sawNull = true;
        continue;
      }
      presentCount++;
      const t = inferType(obj[key]);
      inferredType = mergeTypes(inferredType, t);
      if (t === "object") {
        subObjects.push(obj[key] as Record<string, unknown>);
      }
      if (t === "array" && Array.isArray(obj[key])) {
        arrayValues.push(obj[key] as unknown[]);
      }
    }

    // Build the property schema
    let propSchema: Record<string, unknown> = {};

    if (inferredType !== "mixed" && inferredType !== "null") {
      // A concrete type gets a nullable union when null was also observed.
      const asType = (t: string): string | string[] => (sawNull ? [t, "null"] : t);

      if (inferredType === "object" && subObjects.length > 0) {
        const nested = inferObjectSchema(subObjects);
        propSchema = nested;
        // Override type explicitly (nullable if null appeared alongside objects)
        propSchema.type = asType("object");
      } else if (inferredType === "array") {
        propSchema = { type: asType("array") };
        // Try to infer item type from all array values
        const flatItems = arrayValues.flat();
        if (flatItems.length > 0) {
          let itemType: InferredType = "null",
            itemsSawNull = false;
          for (const item of flatItems) {
            if (item === null) {
              itemsSawNull = true;
              continue;
            }
            itemType = mergeTypes(itemType, inferType(item));
          }
          if (itemType !== "mixed" && itemType !== "null") {
            propSchema.items = { type: itemsSawNull ? [itemType, "null"] : itemType };
          }
        }
      } else {
        propSchema = { type: asType(inferredType) };
      }
    }

    properties[key] = propSchema;

    // Mark as required only if present (non-null) in every object. A field that
    // Is null in some rows stays optional — and its nullable type still allows
    // The null occurrences.
    if (presentCount === objects.length) {
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
  const objects = data.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );

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

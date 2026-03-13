# Task 03: Create React Hooks

## Overview

Create React hooks that wrap Convex queries and mutations for the JSON Data Manager component. These hooks abstract the Convex API interactions and provide a clean interface for React components.

## Files to Create

### 1. `src/hooks/useSchemas.ts`

Schema-related hooks for listing, getting, creating, updating, and deleting schemas.

```typescript
import { useQuery, useMutation } from "convex/react";
import { api } from "@json-data-manager/cms/convex";
import type { Id } from "convex/_generated/dataModel";
import type { SchemaInput } from "../types";

/**
 * Hook to list all schemas with optional pagination.
 * Returns schemas ordered by creation time (newest first).
 */
export function useListSchemas(limit?: number) {
  return useQuery(
    api.schemas.listSchemas,
    limit !== undefined ? { limit } : {}
  );
}

/**
 * Hook to get a single schema by ID.
 * Pass `null` to skip the query (useful when ID is not yet available).
 */
export function useGetSchema(schemaId: string | null) {
  return useQuery(
    api.schemas.getSchema,
    schemaId ? { schemaId: schemaId as Id<"jdm_schemas"> } : "skip"
  );
}

/**
 * Hook to get a schema by its URL-friendly slug.
 */
export function useGetSchemaBySlug(slug: string) {
  return useQuery(api.schemas.getSchemaBySlug, { slug });
}

/**
 * Hook to create a new schema.
 * Returns a mutation function that accepts SchemaInput.
 */
export function useCreateSchema() {
  return useMutation(api.schemas.createSchema);
}

/**
 * Hook to update an existing schema.
 * Supports partial updates for metadata-only changes.
 */
export function useUpdateSchema() {
  return useMutation(api.schemas.updateSchema);
}

/**
 * Hook to delete a schema and all its associated entries.
 */
export function useDeleteSchema() {
  return useMutation(api.schemas.deleteSchema);
}
```

### 2. `src/hooks/useEntries.ts`

Entry-related hooks for managing data entries within schemas.

```typescript
import { useQuery, useMutation } from "convex/react";
import { api } from "@json-data-manager/cms/convex";
import type { Id } from "convex/_generated/dataModel";
import { useState, useCallback } from "react";

/**
 * Hook to list entries for a specific schema.
 * Pass `null` for schemaId to skip the query.
 */
export function useListEntries(schemaId: string | null, limit?: number) {
  return useQuery(
    api.entries.listEntries,
    schemaId ? { schemaId: schemaId as Id<"jdm_schemas">, limit } : "skip"
  );
}

/**
 * Hook for paginated entry listing with cursor-based pagination.
 * Returns entries, pagination state, and navigation functions.
 */
export function useListEntriesPaginated(schemaId: string, pageSize: number = 20) {
  const [cursor, setCursor] = useState<string | null>(null);

  const result = useQuery(
    api.entries.listEntriesPaginated,
    { schemaId: schemaId as Id<"jdm_schemas">, pageSize, cursor: cursor || undefined }
  );

  const nextPage = useCallback(() => {
    if (result?.nextCursor) {
      setCursor(result.nextCursor);
    }
  }, [result?.nextCursor]);

  const previousPage = useCallback(() => {
    // For cursor-based pagination, we'd need to store previous cursors
    // This is a simplified version - consider using a cursor history array
    setCursor(null);
  }, []);

  const reset = useCallback(() => {
    setCursor(null);
  }, []);

  return {
    entries: result?.entries ?? [],
    nextCursor: result?.nextCursor ?? null,
    hasMore: result?.hasMore ?? false,
    isLoading: result === undefined,
    nextPage,
    previousPage,
    reset,
  };
}

/**
 * Hook to get a single entry by ID.
 */
export function useGetEntry(entryId: string | null) {
  return useQuery(
    api.entries.getEntry,
    entryId ? { entryId: entryId as Id<"jdm_entries"> } : "skip"
  );
}

/**
 * Hook to create a new entry.
 */
export function useCreateEntry() {
  return useMutation(api.entries.createEntry);
}

/**
 * Hook to create multiple entries in bulk.
 * Useful for importing data.
 */
export function useCreateBulkEntries() {
  return useMutation(api.entries.createBulkEntries);
}

/**
 * Hook to update an existing entry.
 */
export function useUpdateEntry() {
  return useMutation(api.entries.updateEntry);
}

/**
 * Hook to delete an entry.
 */
export function useDeleteEntry() {
  return useMutation(api.entries.deleteEntry);
}
```

### 3. `src/hooks/useValidation.ts`

Client-side validation hook using AJV for validating data against JSON schemas.

```typescript
import { useState, useCallback, useMemo } from "react";
import { Validator } from "@rjsf/validator-ajv8";
import type { RJSFValidationError } from "@rjsf/utils";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface UseValidationOptions {
  /** JSON Schema to validate against */
  schema: object | undefined;
  /** Custom validator instance (defaults to AJV8) */
  validator?: Validator;
}

export interface UseValidationReturn {
  /** Validate a single data object */
  validate: (data: unknown) => ValidationResult;
  /** Validate an array of data objects */
  validateArray: (dataArray: unknown[]) => Array<ValidationResult & { index: number; data: unknown }>;
  /** Last validation result */
  lastResult: ValidationResult | null;
  /** Whether the last validation passed */
  isValid: boolean | null;
  /** Clear the last result */
  clear: () => void;
}

/**
 * Hook for client-side validation using AJV.
 * Validates data against a JSON Schema without server round-trips.
 */
export function useValidation(options: UseValidationOptions): UseValidationReturn {
  const { schema, validator: customValidator } = options;

  // Use provided validator or create default
  const validator = useMemo(() => customValidator ?? new Validator(), [customValidator]);

  const [lastResult, setLastResult] = useState<ValidationResult | null>(null);

  /**
   * Convert RJSF error property path to JSON Pointer format.
   * ".email" → "/email"
   * ".address.city" → "/address/city"
   */
  const convertPropertyToPath = useCallback((property: string): string => {
    if (property === ".") return "";
    return property.replace(/^\./, "").replace(/\./g, "/");
  }, []);

  /**
   * Convert RJSF validation errors to our ValidationError format.
   */
  const convertErrors = useCallback((errors: RJSFValidationError[]): ValidationError[] => {
    const result: ValidationError[] = [];

    for (const err of errors) {
      let path: string;

      // Handle required field errors
      if (err.name === "required" && err.params && typeof err.params === "object") {
        const missingProperty = (err.params as Record<string, string>).missingProperty;
        path = missingProperty ? `/${missingProperty}` : "";
      } else if (err.property) {
        path = convertPropertyToPath(err.property);
      } else {
        path = "";
      }

      result.push({
        path,
        message: err.message ?? "Validation error",
      });
    }

    return result;
  }, [convertPropertyToPath]);

  /**
   * Validate a single data object against the schema.
   */
  const validate = useCallback((data: unknown): ValidationResult => {
    if (!schema) {
      const result: ValidationResult = { valid: false, errors: [{ path: "", message: "No schema provided" }] };
      setLastResult(result);
      return result;
    }

    const { errors } = validator.validateFormData(data, schema);
    const convertedErrors = convertErrors(errors);

    const result: ValidationResult = {
      valid: errors.length === 0,
      errors: convertedErrors,
    };

    setLastResult(result);
    return result;
  }, [schema, validator, convertErrors]);

  /**
   * Validate an array of data objects.
   * Returns individual results for each item.
   */
  const validateArray = useCallback((dataArray: unknown[]): Array<ValidationResult & { index: number; data: unknown }> => {
    return dataArray.map((data, index) => ({
      index,
      data,
      ...validate(data),
    }));
  }, [validate]);

  /**
   * Clear the last validation result.
   */
  const clear = useCallback(() => {
    setLastResult(null);
  }, []);

  return {
    validate,
    validateArray,
    lastResult,
    isValid: lastResult?.valid ?? null,
    clear,
  };
}

/**
 * Hook for computing unknown paths in data that are not defined in the schema.
 * Useful for detecting extra fields during validation.
 */
export function useUnknownPaths(
  data: unknown,
  schema: Record<string, unknown> | undefined
): Set<string> {
  return useMemo(() => {
    if (!schema || typeof data !== "object" || data === null || Array.isArray(data)) {
      return new Set<string>();
    }

    const unknown = new Set<string>();
    const schemaProps =
      typeof schema.properties === "object" && schema.properties !== null
        ? (schema.properties as Record<string, unknown>)
        : {};

    function computeUnknown(
      obj: Record<string, unknown>,
      props: Record<string, unknown>,
      prefix = ""
    ): void {
      for (const key of Object.keys(obj)) {
        const keyPath = prefix ? `${prefix}/${key}` : `/${key}`;
        if (!(key in props)) {
          unknown.add(keyPath);
        } else {
          const nestedSchema = props[key];
          const nestedData = obj[key];
          if (
            typeof nestedSchema === "object" &&
            nestedSchema !== null &&
            typeof nestedData === "object" &&
            nestedData !== null &&
            !Array.isArray(nestedData)
          ) {
            const nestedProps =
              typeof (nestedSchema as Record<string, unknown>).properties === "object" &&
              (nestedSchema as Record<string, unknown>).properties !== null
                ? ((nestedSchema as Record<string, unknown>).properties as Record<string, unknown>)
                : {};
            computeUnknown(nestedData as Record<string, unknown>, nestedProps, keyPath);
          }
        }
      }
    }

    computeUnknown(data as Record<string, unknown>, schemaProps);
    return unknown;
  }, [data, schema]);
}
```

### 4. `src/hooks/index.ts`

Export all hooks from a single entry point.

```typescript
// Schema hooks
export {
  useListSchemas,
  useGetSchema,
  useGetSchemaBySlug,
  useCreateSchema,
  useUpdateSchema,
  useDeleteSchema,
} from "./useSchemas";

// Entry hooks
export {
  useListEntries,
  useListEntriesPaginated,
  useGetEntry,
  useCreateEntry,
  useCreateBulkEntries,
  useUpdateEntry,
  useDeleteEntry,
} from "./useEntries";

// Validation hooks
export {
  useValidation,
  useUnknownPaths,
  type ValidationError,
  type ValidationResult,
  type UseValidationOptions,
  type UseValidationReturn,
} from "./useValidation";
```

## Usage Examples

### Basic Schema List

```typescript
import { useListSchemas, useCreateSchema } from "@json-data-manager/cms";

function SchemaListPage() {
  const schemas = useListSchemas();
  const createSchema = useCreateSchema();

  if (schemas === undefined) return <Loading />;

  return (
    <div>
      {schemas.schemas.map((schema) => (
        <SchemaCard key={schema._id} schema={schema} />
      ))}
    </div>
  );
}
```

### Entry Creation with Validation

```typescript
import { useCreateEntry, useValidation } from "@json-data-manager/cms";

function EntryForm({ schema }: { schema: object }) {
  const createEntry = useCreateEntry();
  const { validate, isValid } = useValidation({ schema });
  const [formData, setFormData] = useState({});

  const handleSubmit = async () => {
    const result = validate(formData);
    if (!result.valid) return;

    await createEntry({ schemaId: "...", data: formData });
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Form fields */}
    </form>
  );
}
```

### Bulk Upload with Validation

```typescript
import { useCreateBulkEntries, useValidation } from "@json-data-manager/cms";

function BulkUpload({ schema }: { schema: object }) {
  const createBulk = useCreateBulkEntries();
  const { validateArray } = useValidation({ schema });
  const [jsonText, setJsonText] = useState("");

  const handleUpload = async () => {
    const data = JSON.parse(jsonText);
    if (!Array.isArray(data)) return;

    const results = validateArray(data);
    const validEntries = results
      .filter((r) => r.valid)
      .map((r) => r.data);

    if (validEntries.length > 0) {
      await createBulk({ schemaId: "...", dataArray: validEntries });
    }
  };

  return (
    <div>
      <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
      <button onClick={handleUpload}>Upload</button>
    </div>
  );
}
```

## Dependencies

Add these to the package's `package.json`:

```json
{
  "peerDependencies": {
    "convex": "^1.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "dependencies": {
    "@rjsf/validator-ajv8": "^6.0.0",
    "@rjsf/utils": "^6.0.0"
  }
}
```

## Notes

- All hooks follow Convex's patterns for `useQuery` and `useMutation`
- Query hooks return `undefined` while loading (standard Convex behavior)
- Pass `"skip"` or `null` to conditionally skip queries
- The validation hook uses the same AJV8 validator as RJSF for consistency
- Error paths use JSON Pointer format (`/property/nested`) for consistency with JSON Schema

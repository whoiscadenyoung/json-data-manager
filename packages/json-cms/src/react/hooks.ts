"use client";

import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import type { SchemaId, EntryId } from "../client/index.js";
import type { SchemaDoc, EntryDoc } from "./types.js";
import { useJsonCmsApi } from "./provider.js";

// --- Schema queries ---

/** List all schemas, newest first. `undefined` while loading. */
export function useSchemas(): SchemaDoc[] | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.listSchemas, {}) as SchemaDoc[] | undefined;
}

/**
 * Get a single schema by id. Pass `undefined` to skip the query.
 * Returns `null` if the schema does not exist, `undefined` while loading.
 */
export function useSchema(schemaId: SchemaId | undefined): SchemaDoc | null | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.getSchema, schemaId ? { schemaId } : "skip") as
    | SchemaDoc
    | null
    | undefined;
}

// --- Entry queries ---

/** List entries for a schema, newest first. Pass `undefined` to skip. */
export function useEntries(schemaId: SchemaId | undefined): EntryDoc[] | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.listEntries, schemaId ? { schemaId } : "skip") as EntryDoc[] | undefined;
}

/** Get a single entry by id. Pass `undefined` to skip. */
export function useEntry(entryId: EntryId | undefined): EntryDoc | null | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.getEntry, entryId ? { entryId } : "skip") as EntryDoc | null | undefined;
}

// --- Schema mutations ---

export function useCreateSchema() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.createSchema);
  return useCallback(
    (args: { schema: unknown; uiSchema?: unknown }): Promise<SchemaId> =>
      fn(args) as Promise<SchemaId>,
    [fn],
  );
}

export function useUpdateSchema() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.updateSchema);
  return useCallback(
    (args: {
      schemaId: SchemaId;
      title?: string;
      description?: string;
      schema?: unknown;
      uiSchema?: unknown;
    }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

export function useDeleteSchema() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.deleteSchema);
  return useCallback(
    (args: { schemaId: SchemaId }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

// --- Entry mutations ---

export function useCreateEntry() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.createEntry);
  return useCallback(
    (args: { schemaId: SchemaId; data: unknown }): Promise<EntryId> => fn(args) as Promise<EntryId>,
    [fn],
  );
}

export function useCreateEntriesBulk() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.createEntriesBulk);
  return useCallback(
    (args: { schemaId: SchemaId; dataArray: unknown[] }): Promise<EntryId[]> =>
      fn(args) as Promise<EntryId[]>,
    [fn],
  );
}

export function useUpdateEntry() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.updateEntry);
  return useCallback(
    (args: { entryId: EntryId; data: unknown }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

export function useDeleteEntry() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.deleteEntry);
  return useCallback(
    (args: { entryId: EntryId }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

export function useDeleteEntriesBySchema() {
  const api = useJsonCmsApi();
  const fn = useMutation(api.deleteEntriesBySchema);
  return useCallback(
    (args: { schemaId: SchemaId }): Promise<number> => fn(args) as Promise<number>,
    [fn],
  );
}

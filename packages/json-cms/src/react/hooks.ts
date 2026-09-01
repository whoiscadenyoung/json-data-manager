"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

import type { EntryId, SchemaId } from "../client/index.js";
import { useJsonCmsApi } from "./provider.js";
import type { EntryDoc, ImportStatusDoc, SchemaDoc } from "./types.js";

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
  return useQuery(api.getSchema, schemaId ? { schemaId } : "skip") as SchemaDoc | null | undefined;
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
  const api = useJsonCmsApi(),
    fn = useMutation(api.createSchema);
  return useCallback(
    async (args: { schema: unknown; uiSchema?: unknown }): Promise<SchemaId> =>
      fn(args) as Promise<SchemaId>,
    [fn],
  );
}

export function useUpdateSchema() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.updateSchema);
  return useCallback(
    async (args: {
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
  const api = useJsonCmsApi(),
    fn = useMutation(api.deleteSchema);
  return useCallback(
    async (args: { schemaId: SchemaId }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

// --- Entry mutations ---

export function useCreateEntry() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.createEntry);
  return useCallback(
    async (args: { schemaId: SchemaId; data: unknown }): Promise<EntryId> =>
      fn(args) as Promise<EntryId>,
    [fn],
  );
}

export function useCreateEntriesBulk() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.createEntriesBulk);
  return useCallback(
    async (args: { schemaId: SchemaId; dataArray: unknown[] }): Promise<EntryId[]> =>
      fn(args) as Promise<EntryId[]>,
    [fn],
  );
}

export function useUpdateEntry() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.updateEntry);
  return useCallback(
    async (args: { entryId: EntryId; data: unknown }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

export function useDeleteEntry() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.deleteEntry);
  return useCallback(
    async (args: { entryId: EntryId }): Promise<null> => fn(args) as Promise<null>,
    [fn],
  );
}

export function useDeleteEntriesBySchema() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.deleteEntriesBySchema);
  return useCallback(
    async (args: { schemaId: SchemaId }): Promise<number> => fn(args) as Promise<number>,
    [fn],
  );
}

// --- Dataset import (batched, monitored) ---

export interface StartDatasetImportArgs {
  schema: unknown;
  uiSchema?: unknown;
  rows: unknown[];
}

export interface DatasetImportHandle {
  /** The created schema's id, once `start` has run. */
  schemaId: SchemaId | undefined;
  /** The import's id, once `start` has run. */
  importId: string | undefined;
  /** Live import status, or `undefined` before start / while loading. */
  status: ImportStatusDoc | null | undefined;
  /**
   * Create the schema, upload the rows to storage, and kick off the batched
   * import. Returns the new schema and import ids. Subscribe to `status` for
   * live progress.
   */
  start: (args: StartDatasetImportArgs) => Promise<{ schemaId: SchemaId; importId: string }>;
}

/**
 * Orchestrates a batched, monitored dataset import: creates the schema, uploads
 * the row payload to Convex file storage, starts the import workflow, and
 * subscribes to its live progress.
 */
export function useDatasetImport(): DatasetImportHandle {
  const api = useJsonCmsApi(),
    createSchema = useMutation(api.createSchema),
    generateUploadUrl = useMutation(api.generateImportUploadUrl),
    startImport = useMutation(api.startImport),
    [schemaId, setSchemaId] = useState<SchemaId | undefined>(),
    [importId, setImportId] = useState<string | undefined>(),
    status = useQuery(api.getImportStatus, importId ? { importId } : "skip") as
      | ImportStatusDoc
      | null
      | undefined,
    start = useCallback(
      async ({ schema, uiSchema, rows }: StartDatasetImportArgs) => {
        const newSchemaId = (await createSchema({ schema, uiSchema })) as SchemaId,
          uploadUrl = (await generateUploadUrl({})) as string,
          res = await fetch(uploadUrl, {
            body: JSON.stringify(rows),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
        if (!res.ok) {
          throw new Error("Failed to upload import data.");
        }
        const { storageId } = (await res.json()) as { storageId: string },
          newImportId = (await startImport({
            schemaId: newSchemaId,
            storageId,
            total: rows.length,
          })) as string;
        setSchemaId(newSchemaId);
        setImportId(newImportId);
        return { importId: newImportId, schemaId: newSchemaId };
      },
      [createSchema, generateUploadUrl, startImport],
    );

  return { importId, schemaId, start, status };
}

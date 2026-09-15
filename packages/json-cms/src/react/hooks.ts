"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

import type { EntryId, SchemaId } from "../client/index.js";
import { useAllPaginated } from "./lib/all-paginated.js";
import { chunkRowsForImport } from "./lib/chunk-rows.js";
import { useJsonCmsApi } from "./provider.js";
import type {
  EntryDoc,
  GeometryDoc,
  ImportStatusDoc,
  ReferencingEntryDoc,
  SchemaDoc,
} from "./types.js";

// --- Schema queries ---

/** List all schemas, newest first. `undefined` while loading. */
export function useSchemas(): SchemaDoc[] | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.listSchemas, {});
}

/**
 * Get a single schema by id. Pass `undefined` to skip the query.
 * Returns `null` if the schema does not exist, `undefined` while loading.
 */
export function useSchema(schemaId: SchemaId | undefined): SchemaDoc | null | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.getSchema, schemaId ? { schemaId } : "skip");
}

// --- Entry queries ---

/** List entries for a schema, newest first. Pass `undefined` to skip. */
export function useEntries(schemaId: SchemaId | undefined): EntryDoc[] | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.listEntries, schemaId ? { schemaId } : "skip");
}

/** Get a single entry by id. Pass `undefined` to skip. */
export function useEntry(entryId: EntryId | undefined): EntryDoc | null | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.getEntry, entryId ? { entryId } : "skip");
}

/**
 * Entries from several datasets at once, flattened into one list. Useful for
 * building a foreign-reference field's candidate picker without one query
 * per referenced dataset. Pass `undefined`/`[]` to skip.
 */
export function useEntriesForSchemas(schemaIds: SchemaId[] | undefined): EntryDoc[] | undefined {
  const api = useJsonCmsApi();
  return useQuery(
    api.listEntriesForSchemas,
    schemaIds && schemaIds.length > 0 ? { schemaIds } : "skip",
  );
}

/**
 * Reverse lookup: every other dataset's entry that currently references
 * `entryId` via a foreign-reference field. Pass `undefined` to skip.
 */
export function useReferencingEntries(
  entryId: EntryId | undefined,
): ReferencingEntryDoc[] | undefined {
  const api = useJsonCmsApi();
  return useQuery(api.listReferencingEntries, entryId ? { entryId } : "skip");
}

/**
 * List the full-geometry rows for a schema — the only place that pulls full
 * coordinate payloads (e.g. for a map view). `useEntries` never touches this
 * data, so rendering a properties table never pays for it. Pass `undefined`
 * to skip.
 *
 * Fetches every page automatically (see `useAllPaginated`) — `listGeometries`
 * is paginated server-side because a dataset's cumulative geometry payload
 * can exceed Convex's per-execution read-byte budget even though each row is
 * safely under its own document-size limit — and returns `undefined` while
 * any page is still loading, matching every other hook in this file.
 */
export function useGeometries(schemaId: SchemaId | undefined): GeometryDoc[] | undefined {
  const api = useJsonCmsApi(),
    { isLoading, results } = useAllPaginated(api.listGeometries, schemaId ? { schemaId } : "skip");
  return isLoading ? undefined : results;
}

// --- Schema mutations ---

export function useCreateSchema() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.createSchema);
  return useCallback(
    async (args: { schema: unknown; uiSchema?: unknown }): Promise<SchemaId> => fn(args),
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
    }): Promise<null> => fn(args),
    [fn],
  );
}

export function useDeleteSchema() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.deleteSchema);
  return useCallback(async (args: { schemaId: SchemaId }): Promise<null> => fn(args), [fn]);
}

// --- Entry mutations ---

/**
 * `createEntry`/`updateEntry`/`createEntriesBulk` all carry `geometry` over
 * the wire as a JSON string (see `types.ts`'s `GeometryDoc` doc comment for
 * why — Convex's 8192-elements-per-array limit, which a raw nested-array
 * geometry argument can hit for real-world GIS data). These hooks keep the
 * ergonomic `Geometry`-object input the rest of the app already uses;
 * `toGeometryArg` does the one-line conversion at the boundary.
 */
function toGeometryArg(geometry: unknown): string | undefined {
  return geometry === undefined ? undefined : JSON.stringify(geometry);
}

export function useCreateEntry() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.createEntry);
  return useCallback(
    async (args: { schemaId: SchemaId; data: unknown; geometry?: unknown }): Promise<EntryId> =>
      fn({ ...args, geometry: toGeometryArg(args.geometry) }),
    [fn],
  );
}

export function useCreateEntriesBulk() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.createEntriesBulk);
  return useCallback(
    async (args: {
      schemaId: SchemaId;
      entries: Array<{ data: unknown; geometry?: unknown }>;
    }): Promise<EntryId[]> =>
      fn({
        entries: args.entries.map((entry) => ({
          data: entry.data,
          geometry: toGeometryArg(entry.geometry),
        })),
        schemaId: args.schemaId,
      }),
    [fn],
  );
}

export function useUpdateEntry() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.updateEntry);
  return useCallback(
    // `geometry: null` explicitly clears the entry's geometry; `undefined`/omitted leaves it untouched.
    async (args: { entryId: EntryId; data: unknown; geometry?: unknown }): Promise<null> =>
      fn({ ...args, geometry: args.geometry === null ? null : toGeometryArg(args.geometry) }),
    [fn],
  );
}

export function useDeleteEntry() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.deleteEntry);
  return useCallback(async (args: { entryId: EntryId }): Promise<null> => fn(args), [fn]);
}

export function useDeleteEntriesBySchema() {
  const api = useJsonCmsApi(),
    fn = useMutation(api.deleteEntriesBySchema);
  return useCallback(async (args: { schemaId: SchemaId }): Promise<number> => fn(args), [fn]);
}

// --- Dataset import (batched, monitored) ---

export interface StartDatasetImportArgs {
  schema: unknown;
  uiSchema?: unknown;
  /** Dataset kind. Omit for a standard (plain JSON-schema) dataset. */
  kind?: "standard" | "geospatial";
  /**
   * The geometry type this dataset is locked to. Required when
   * `kind === "geospatial"`. Kept loosely typed as `string` here — the
   * component validates it for real; this package doesn't need the geometry
   * validator types just to thread the value through.
   */
  geometryType?: string;
  /**
   * Round every geometry coordinate to 6 decimal places (~0.11 m) as it's
   * stored — smaller payloads, faster maps, no visible difference. The
   * original file (below) stays re-downloadable regardless. Geospatial
   * imports only.
   */
  simplifyGeometry?: boolean;
  /**
   * The exact file this import came from, retained in Convex file storage so
   * it can be re-downloaded later (see the dataset's `getSourceFileUrl`).
   * Uploaded as its own blob and attached to the dataset by `startImport`.
   */
  sourceFile?: File | null;
  rows: Array<{ data: unknown; geometry?: unknown }>;
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
    status = useQuery(api.getImportStatus, importId ? { importId } : "skip"),
    start = useCallback(
      async ({
        schema,
        uiSchema,
        kind,
        geometryType,
        simplifyGeometry,
        sourceFile,
        rows,
      }: StartDatasetImportArgs) => {
        const newSchemaId = await createSchema({
            geometryType,
            kind,
            schema,
            simplifyGeometry,
            uiSchema,
          }),
          // Split client-side (the browser already has every row parsed in
          // memory) and upload each chunk to its own blob — never one giant
          // blob. See `chunkRowsForImport`'s doc comment for why: Convex
          // components can't use the Node runtime, so no server-side step
          // could otherwise safely parse a large upload in one shot.
          chunks = chunkRowsForImport(rows),
          storageIds: string[] = [];
        // Sequential: keeps upload order predictable and mirrors the
        // workflow's own sequential chunk processing; could be
        // parallelized later if upload latency becomes a bottleneck.
        for (const chunk of chunks) {
          // oxlint-disable-next-line no-await-in-loop
          const uploadUrl = await generateUploadUrl({}),
            // oxlint-disable-next-line no-await-in-loop
            res = await fetch(uploadUrl, {
              body: JSON.stringify(chunk),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });
          if (!res.ok) {
            throw new Error("Failed to upload import data.");
          }
          // oxlint-disable-next-line no-await-in-loop
          const body: unknown = await res.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("storageId" in body) ||
            typeof body.storageId !== "string"
          ) {
            throw new Error("Import upload did not return a storageId.");
          }
          storageIds.push(body.storageId);
        }

        // Retain the original file as its own blob — deliberately NOT in
        // `storageIds` (the import workflow deletes chunk blobs as it
        // consumes them; this one must survive).
        let sourceFileRef: { name: string; size: number; storageId: string } | undefined;
        if (sourceFile) {
          const uploadUrl = await generateUploadUrl({}),
            res = await fetch(uploadUrl, {
              body: sourceFile,
              headers: { "Content-Type": sourceFile.type || "application/octet-stream" },
              method: "POST",
            });
          if (!res.ok) {
            throw new Error("Failed to upload the original file.");
          }
          const body: unknown = await res.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("storageId" in body) ||
            typeof body.storageId !== "string"
          ) {
            throw new Error("Original-file upload did not return a storageId.");
          }
          sourceFileRef = {
            name: sourceFile.name,
            size: sourceFile.size,
            storageId: body.storageId,
          };
        }

        const newImportId = await startImport({
          schemaId: newSchemaId,
          sourceFile: sourceFileRef,
          storageIds,
          total: rows.length,
        });
        setSchemaId(newSchemaId);
        setImportId(newImportId);
        return { importId: newImportId, schemaId: newSchemaId };
      },
      [createSchema, generateUploadUrl, startImport, setSchemaId, setImportId],
    );

  return { importId, schemaId, start, status };
}

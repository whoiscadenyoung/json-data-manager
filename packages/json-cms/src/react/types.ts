import type { FunctionReference } from "convex/server";

import type { EntryId, SchemaId } from "../client/index.js";

/**
 * A stored JSON schema document, as returned by the component's queries.
 */
export interface SchemaDoc {
  _id: SchemaId;
  _creationTime: number;
  title: string;
  description: string;
  /** JSON Schema object. */
  schema: unknown;
  /** Optional RJSF UI schema object. */
  uiSchema?: unknown;
}

/**
 * A stored data entry document, as returned by the component's queries.
 */
export interface EntryDoc {
  _id: EntryId;
  _creationTime: number;
  schemaId: SchemaId;
  /** Entry data conforming to the referenced schema. */
  data: unknown;
}

type Empty = Record<string, never>;

/**
 * The set of function references a host app exposes for the JSON CMS
 * component (via `exposeApi`). Map your app's exposed functions to this
 * shape and hand it to `<JsonCmsProvider api={...} />`.
 *
 * The references carry their arg and return types so the hooks infer results
 * without casting. Ids are typed as plain strings here (the component exposes
 * them as `v.string()` at the trust boundary); the hooks re-brand them as
 * `SchemaId` / `EntryId` on the way out.
 */
export interface JsonCmsApi {
  listSchemas: FunctionReference<"query", "public", Empty, SchemaDoc[]>;
  getSchema: FunctionReference<"query", "public", { schemaId: string }, SchemaDoc | null>;
  createSchema: FunctionReference<
    "mutation",
    "public",
    { schema: unknown; uiSchema?: unknown },
    SchemaId
  >;
  updateSchema: FunctionReference<
    "mutation",
    "public",
    {
      schemaId: string;
      title?: string;
      description?: string;
      schema?: unknown;
      uiSchema?: unknown;
    },
    null
  >;
  deleteSchema: FunctionReference<"mutation", "public", { schemaId: string }, null>;
  listEntries: FunctionReference<"query", "public", { schemaId: string }, EntryDoc[]>;
  getEntry: FunctionReference<"query", "public", { entryId: string }, EntryDoc | null>;
  createEntry: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; data: unknown },
    EntryId
  >;
  createEntriesBulk: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; dataArray: unknown[] },
    EntryId[]
  >;
  updateEntry: FunctionReference<"mutation", "public", { entryId: string; data: unknown }, null>;
  deleteEntry: FunctionReference<"mutation", "public", { entryId: string }, null>;
  deleteEntriesBySchema: FunctionReference<"mutation", "public", { schemaId: string }, number>;
  // Batched dataset import
  generateImportUploadUrl: FunctionReference<"mutation", "public", Empty, string>;
  startImport: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; storageId: string; total: number },
    string
  >;
  getImportStatus: FunctionReference<
    "query",
    "public",
    { importId: string },
    ImportStatusDoc | null
  >;
}

/**
 * Live status of a batched dataset import, as returned by `getImportStatus`.
 */
export interface ImportStatusDoc {
  _id: string;
  _creationTime: number;
  schemaId: SchemaId;
  storageId: string;
  total: number;
  processed: number;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  workflowId?: string;
}

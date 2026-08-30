import type { FunctionReference } from "convex/server";
import type { SchemaId, EntryId } from "../client/index.js";

/**
 * A stored JSON schema document, as returned by the component's queries.
 */
export type SchemaDoc = {
  _id: SchemaId;
  _creationTime: number;
  title: string;
  description: string;
  /** JSON Schema object. */
  schema: unknown;
  /** Optional RJSF UI schema object. */
  uiSchema?: unknown;
};

/**
 * A stored data entry document, as returned by the component's queries.
 */
export type EntryDoc = {
  _id: EntryId;
  _creationTime: number;
  schemaId: SchemaId;
  /** Entry data conforming to the referenced schema. */
  data: unknown;
};

/**
 * The set of function references a host app exposes for the JSON CMS
 * component (via `exposeApi`). Map your app's exposed functions to this
 * shape and hand it to `<JsonCmsProvider api={...} />`.
 *
 * The references are intentionally loosely typed here so that any app's
 * generated function references are assignable regardless of how their
 * `Id` types are branded. The hooks re-apply the concrete `SchemaDoc` /
 * `EntryDoc` result types on top.
 */
export interface JsonCmsApi {
  listSchemas: FunctionReference<"query">;
  getSchema: FunctionReference<"query">;
  createSchema: FunctionReference<"mutation">;
  updateSchema: FunctionReference<"mutation">;
  deleteSchema: FunctionReference<"mutation">;
  listEntries: FunctionReference<"query">;
  getEntry: FunctionReference<"query">;
  createEntry: FunctionReference<"mutation">;
  createEntriesBulk: FunctionReference<"mutation">;
  updateEntry: FunctionReference<"mutation">;
  deleteEntry: FunctionReference<"mutation">;
  deleteEntriesBySchema: FunctionReference<"mutation">;
  // Batched dataset import
  generateImportUploadUrl: FunctionReference<"mutation">;
  startImport: FunctionReference<"mutation">;
  getImportStatus: FunctionReference<"query">;
}

/**
 * Live status of a batched dataset import, as returned by `getImportStatus`.
 */
export type ImportStatusDoc = {
  _id: string;
  _creationTime: number;
  schemaId: SchemaId;
  storageId: string;
  total: number;
  processed: number;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  workflowId?: string;
};

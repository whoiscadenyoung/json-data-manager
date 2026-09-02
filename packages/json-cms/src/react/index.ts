"use client";

// Provider + context
export { JsonCmsProvider, useJsonCmsApi } from "./provider.js";

// Hooks
export {
  useSchemas,
  useSchema,
  useEntries,
  useEntry,
  useCreateSchema,
  useUpdateSchema,
  useDeleteSchema,
  useCreateEntry,
  useCreateEntriesBulk,
  useUpdateEntry,
  useDeleteEntry,
  useDeleteEntriesBySchema,
  useDatasetImport,
} from "./hooks.js";
export type { StartDatasetImportArgs, DatasetImportHandle } from "./hooks.js";

// Types
export type { JsonCmsApi, SchemaDoc, EntryDoc, ImportStatusDoc } from "./types.js";
export type { SchemaId, EntryId } from "../client/index.js";

// Framework-agnostic utilities
export { inferSchemaFromData } from "./lib/infer-schema.js";
export { parseDataRows } from "./lib/parse-data.js";
export type { ParseDataResult, ParseError } from "./lib/parse-data.js";
export {
  createDefaultUiSchema,
  mergeUiSchemas,
  DEFAULT_SUBMIT_BUTTON_OPTIONS,
} from "./lib/ui-schema.js";
export type { UiSchema, UiOptions, UiSchemaSubmitButtonOptions } from "./lib/ui-schema.js";
